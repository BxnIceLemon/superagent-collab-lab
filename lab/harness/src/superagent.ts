import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SuperagentOptions } from './experiment.ts'
import type { Launcher } from './runner.ts'

/**
 * Runs the unmodified dsh-superagent prototype on one lab task, offline apart
 * from the model providers.
 *
 * The prototype needs a GitHub repository and an agent account with push
 * access. Here its GitHub Source stays off, and its account check is answered
 * by an offline stand-in for `gh` (lab/superagent-lab/bin/gh-offline). The
 * operator's task reaches it through the `lab-task` Source
 * (lab/superagent-lab), and each Ticket's directory is a link to the run
 * workspace, where the gates run afterwards.
 */

/** Profile name inside the run's own DSH home. */
export const PROFILE = 'superagent'
/** The operator's id on the lab-task Source, on the prototype's allowed list. */
export const OPERATOR = 'operator'

export interface SuperagentPaths {
  /** lab/superagent, built. */
  prototype: string
  /** lab/superagent-lab. */
  labSource: string
}

export function superagentPaths(labDir: string): SuperagentPaths {
  return { prototype: join(labDir, 'superagent'), labSource: join(labDir, 'superagent-lab') }
}

/** One Ticket as the run record keeps it. */
export interface TicketSummary {
  id: string
  title: string
  state: string
  stage: string
  action: string | null
  outcome: string | null
  summary: string | null
}

export type StopReason = 'settled' | 'needs-person' | 'no-ticket' | 'timeout' | 'server-exited'

export interface SuperagentResult {
  code: number | null
  signal: string | null
  wallMs: number
  stopReason: StopReason
  tickets: TicketSummary[]
  /** Messages the agent sent to the operator. */
  replies: number
  /** Messages the operator sent, the task included. */
  operatorMessages: number
}

interface TicketItem {
  id: string
  title?: string
  state?: string
  stage?: string
  action?: string
  ended?: { outcome?: string }
  summary?: string
}

export interface Observation {
  /** Milliseconds since the task was posted. */
  at: number
  open: TicketItem[]
  ended: TicketItem[]
}

/**
 * Decides whether a run is over from what the API reported so far.
 * A run is over once no Ticket can move without a person for `quietMs`: every
 * Ticket ended, or the open ones wait for a person. It also ends when no
 * Ticket appeared within `noTicketMs`, or after `timeoutMs`.
 * @param history - observations, oldest first.
 * @returns why the run is over, or null while it goes on.
 */
export function stopReason(
  history: readonly Observation[],
  limits: { quietMs: number; noTicketMs: number; timeoutMs: number },
): StopReason | null {
  const last = history.at(-1)
  if (last === undefined) return null
  if (last.at >= limits.timeoutMs) return 'timeout'
  const anyTicket = history.some(o => o.open.length + o.ended.length > 0)
  if (!anyTicket) return last.at >= limits.noTicketMs ? 'no-ticket' : null
  const still = (o: Observation) => o.open.every(t => t.stage === 'person')
  // The newest moment from which every observation has had nothing in progress.
  let since = last.at
  for (let i = history.length - 1; i >= 0 && still(history[i]!); i--) since = history[i]!.at
  if (!still(last) || last.at - since < limits.quietMs) return null
  return last.open.length > 0 ? 'needs-person' : 'settled'
}

function summarize(t: TicketItem): TicketSummary {
  return {
    id: t.id,
    title: t.title ?? '',
    state: t.state ?? 'unknown',
    stage: t.stage ?? 'unknown',
    action: t.action ?? null,
    outcome: t.ended?.outcome ?? null,
    summary: t.summary ?? null,
  }
}

/** The management API of a running instance. */
class Api {
  private readonly base: string

  constructor(base: string) {
    this.base = base
  }

  async request<T>(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}/orchestrator/api/${path}`, {
      method,
      headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return JSON.parse(text) as T
  }

  get<T>(path: string): Promise<T> {
    return this.request('GET', path)
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request('PUT', path, body)
  }

  /** Waits until the API answers and `ok` accepts its state. */
  async until(ok: (state: State) => boolean, timeoutMs: number, exited: () => boolean): Promise<State> {
    const deadline = Date.now() + timeoutMs
    let last: unknown
    while (Date.now() < deadline && !exited()) {
      try {
        const state = await this.get<State>('state')
        if (ok(state)) return state
        last = state.setup?.problem ?? state.health?.runtime
      } catch (error) {
        // Not listening yet, or restarting after a settings save.
        last = error
      }
      await delay(1000)
    }
    throw new Error(`dsh-superagent did not become ready: ${exited() ? 'the server exited' : JSON.stringify(String(last))}`)
  }
}

interface State {
  setup?: { problem: unknown; accounts: unknown }
  health?: { runtime?: { state: string } }
}

interface Block<T> { value: T; revision: number }
interface Settings {
  blocks: { policy: Block<{ sources: Record<string, unknown> }>; executor: Block<Record<string, unknown>> }
  sources: { id: string; revision: number }[]
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address !== null ? resolvePort(address.port) : reject(new Error('no port'))))
    })
  })
}

function run(launcher: Launcher, args: string[], env: NodeJS.ProcessEnv, cwd: string, log: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(launcher.command, [...launcher.args, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = createWriteStream(log, { flags: 'a' })
    child.stdout.pipe(out)
    child.stderr.pipe(out)
    child.on('error', reject)
    child.on('close', code => {
      out.end()
      if (code === 0) resolveRun()
      else reject(new Error(`dsh ${args.join(' ')} exited with ${code}; see ${log}`))
    })
  })
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** Ends the server, then anything it left running in its process group. */
async function stop(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal)
    } catch {
      // The group is already gone.
    }
  }
  group('SIGTERM')
  const done = await Promise.race([exited.then(() => true), delay(60_000).then(() => false)])
  if (!done) group('SIGKILL')
  await exited
  group('SIGKILL')
}

export interface SuperagentRun {
  launcher: Launcher
  paths: SuperagentPaths
  runDir: string
  workspace: string
  home: string
  prompt: string
  patches: string[]
  env: NodeJS.ProcessEnv
  options: SuperagentOptions
}

/**
 * Starts the prototype, gives it the task, waits until it is over and stops it.
 * @param r - where the run lives and how to start `dsh`.
 * @returns how the run ended and the Tickets it left.
 */
export async function runSuperagent(r: SuperagentRun): Promise<SuperagentResult> {
  if (!existsSync(join(r.paths.prototype, 'lib/index.js'))) {
    throw new Error(`dsh-superagent is not built; run: pnpm --dir ${r.paths.prototype} build`)
  }
  const log = join(r.runDir, 'agent.stderr.log')
  const state = join(r.runDir, 'superagent')
  const tickets = join(r.runDir, 'tickets')
  const inbox = join(r.runDir, 'inbox.jsonl')
  const outbox = join(r.runDir, 'outbox.jsonl')
  await mkdir(state, { recursive: true })
  await mkdir(tickets, { recursive: true })

  // A profile of the run's own, made from DSH's Web template.
  await run(r.launcher, [PROFILE, '--from-default-profile', 'web', '--dump-config'], r.env, r.runDir, log)
  await run(r.launcher, ['plugin', '--profile', PROFILE, 'add', `link:${r.paths.prototype}`, `link:${r.paths.labSource}`], r.env, r.runDir, log)
  const port = await freePort()
  await writeFile(
    join(r.home, 'profiles', PROFILE, 'cordis.patch.yml'),
    [
      '# Written by the lab harness for one run.',
      '- id: webserver',
      '  config:',
      '    host: 127.0.0.1',
      `    port: ${port}`,
      '- id: dsh-superagent',
      '  config:',
      `    stateDir: ${JSON.stringify(state)}`,
      '- insert:',
      '    - id: lab-task-source',
      '      name: collab-lab-superagent-source',
      '',
    ].join('\n'),
  )

  const started = performance.now()
  const child = spawn(
    r.launcher.command,
    [...r.launcher.args, PROFILE, ...r.patches.flatMap(p => ['--patch', p]), '--no-open', '--port', String(port)],
    { cwd: r.runDir, env: r.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  const out = createWriteStream(log, { flags: 'a' })
  child.stdout!.pipe(out)
  child.stderr!.pipe(out)
  let exit: { code: number | null; signal: string | null } | undefined
  const exited = new Promise<void>(resolveExit => {
    child.on('close', (code, signal) => {
      exit = { code, signal }
      out.end()
      resolveExit()
    })
  })
  const api = new Api(`http://127.0.0.1:${port}`)
  const isExited = () => exit !== undefined

  let stopReasonValue: StopReason = 'server-exited'
  let last: Observation = { at: 0, open: [], ended: [] }
  try {
    await api.until(() => true, 180_000, isExited)
    const settings = await api.get<Settings>('settings')
    const revision = (id: string) => settings.sources.find(s => s.id === id)?.revision ?? 0

    // The account check passes through the offline gh; the GitHub Source stays off.
    const gh = join(r.paths.labSource, 'bin/gh-offline')
    await api.put('settings/source:github', {
      value: { enabled: false, config: { repository: 'lab/workspace', cli: gh } },
      revision: revision('github'),
    })
    await api.until(s => s.setup?.accounts != null && s.health?.runtime?.state === 'ready', 180_000, isExited)

    const fresh = await api.get<Settings>('settings')
    const policy = fresh.blocks.policy
    await api.put('settings/policy', {
      value: { ...policy.value, sources: { ...policy.value.sources, 'lab-task': { allowed: [{ id: OPERATOR }] } } },
      revision: policy.revision,
    })
    const executor = fresh.blocks.executor
    await api.put('settings/executor', {
      value: { ...executor.value, directory: tickets, prepare: `ln -s ${quote(r.workspace)} "$DSH_SUPERAGENT_DIR"` },
      revision: executor.revision,
    })
    const prompts = await api.get<{ current: { revision: number; config: Record<string, unknown> } }>('prompts')
    const delivery = await readFile(join(r.paths.labSource, 'prompts/delivery.md'), 'utf8')
    await api.put('prompts', { config: { ...prompts.current.config, delivery }, baseRevision: prompts.current.revision })

    // The task, then the Source that reads it.
    const posted = Date.now()
    await appendFile(inbox, `${JSON.stringify({ id: 'task', from: OPERATOR, text: r.prompt, at: new Date(posted).toISOString() })}\n`)
    await api.put('settings/source:lab-task', {
      value: { enabled: true, config: { inbox, outbox, pollSeconds: 2 } },
      revision: revision('lab-task'),
    })

    const limits = {
      quietMs: r.options.quietSec * 1000,
      noTicketMs: r.options.noTicketMin * 60_000,
      timeoutMs: r.options.timeoutMin * 60_000,
    }
    const history: Observation[] = []
    for (;;) {
      if (isExited()) break
      const open = (await api.get<{ items: TicketItem[] }>('tickets?limit=100')).items
      const ended = (await api.get<{ items: TicketItem[] }>('tickets?state=ended&limit=100')).items
      last = { at: Date.now() - posted, open, ended }
      history.push(last)
      const reason = stopReason(history, limits)
      if (reason !== null) {
        stopReasonValue = reason
        break
      }
      await delay(r.options.pollSec * 1000)
    }
  } finally {
    if (!isExited()) await stop(child, exited)
  }

  const count = async (file: string) => {
    try {
      return (await readFile(file, 'utf8')).split('\n').filter(l => l.trim() !== '').length
    } catch {
      return 0
    }
  }
  return {
    code: exit?.code ?? null,
    signal: exit?.signal ?? null,
    wallMs: Math.round(performance.now() - started),
    stopReason: stopReasonValue,
    tickets: [...last.open, ...last.ended].map(summarize),
    replies: await count(outbox),
    operatorMessages: await count(inbox),
  }
}
