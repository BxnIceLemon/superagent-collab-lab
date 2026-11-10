import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { priceUsage, totalCost, type ModelCatalog } from './catalog.ts'
import type { Condition, Gate, LabTask, Loaded } from './experiment.ts'
import { readExternalUsage } from './external-usage.ts'
import { detectHostTools, type HostTools } from './host-tools.ts'
import { RunRecord, type GateResult } from './record.ts'
import { findSessionLogs, followUpMessages, mergeUsage, readSessionLog } from './session-log.ts'

/** The command that starts `dsh`; the runner appends the launcher and app arguments. */
export interface Launcher {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * Starts `dsh` from this repository's source, as `pnpm dsh` does.
 *
 * tsx reads the tsconfig of the working directory to map workspace packages to
 * their sources; the run's working directory is the task workspace, so the
 * repository tsconfig is named explicitly.
 * @param repoRoot - root of the DSH checkout, with dependencies installed.
 * @returns a launcher usable from any working directory.
 */
export function sourceLauncher(repoRoot: string): Launcher {
  const require = createRequire(join(repoRoot, 'package.json'))
  const tsx = pathToFileURL(require.resolve('tsx/esm')).href
  return {
    command: process.execPath,
    args: ['--import', tsx, join(repoRoot, 'apps/cli/src/bin.ts')],
    env: { TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json') },
  }
}

export interface RunOptions {
  repoRoot: string
  resultsDir: string
  task: Loaded<LabTask>
  condition: Loaded<Condition>
  catalog?: ModelCatalog
  launcher?: Launcher
  /** Host CLIs; detected when omitted. */
  hostTools?: HostTools
  now?: () => Date
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function gitHead(repoRoot: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

interface Exit {
  code: number | null
  signal: string | null
  wallMs: number
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; stdout: string; stderr: string; timeoutMs?: number },
): Promise<Exit> {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now()
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    })
    const out = createWriteStream(options.stdout)
    const err = createWriteStream(options.stderr)
    child.stdout.pipe(out)
    child.stderr.pipe(err)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      out.end()
      err.end()
      resolvePromise({ code, signal, wallMs: Math.round(performance.now() - started) })
    })
    child.stdin.end(options.stdin)
  })
}

async function runGate(gate: Gate, workspace: string, logDir: string): Promise<GateResult> {
  const log = join(logDir, `${gate.id}.log`)
  const exit = await runProcess('sh', ['-c', gate.run], {
    cwd: workspace,
    env: process.env,
    stdin: '',
    stdout: log,
    stderr: log.replace(/\.log$/, '.err.log'),
    timeoutMs: gate.timeoutSec * 1000,
  })
  return { id: gate.id, passed: exit.code === 0, exitCode: exit.code, wallMs: exit.wallMs }
}

/**
 * Runs one task under one condition and writes `<resultsDir>/<runId>/run.json`.
 *
 * The run gets a fresh workspace and a fresh DSH home, so nothing from the
 * operator's own DSH setup or an earlier run leaks in.
 * @param options - what to run and where to write it.
 * @returns the run record.
 */
export async function runExperiment(options: RunOptions): Promise<RunRecord> {
  const started = (options.now ?? (() => new Date()))()
  const { task, condition } = options
  const runId = `${stamp(started)}-${task.value.id}-${condition.value.id}`
  const runDir = join(options.resultsDir, runId)
  const workspace = join(runDir, 'workspace')
  const home = join(runDir, 'dsh-home')
  const gateLogs = join(runDir, 'gates')
  await mkdir(workspace, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(gateLogs, { recursive: true })
  if (task.value.fixture !== undefined) await cp(task.value.fixture, workspace, { recursive: true })

  const launcher = options.launcher ?? sourceLauncher(options.repoRoot)
  const hostTools = options.hostTools ?? detectHostTools(options.repoRoot)
  // Lab defaults, which a condition's env may override: no telemetry, and the
  // host Claude Code for Claude delegation (see worker-claude-code.yml).
  const labEnv: Record<string, string> = {
    DSH_TELEMETRY_MODE: 'DISABLED',
    ...(hostTools.claudeCode === null ? {} : { LAB_CLAUDE_EXECUTABLE: hostTools.claudeCode.path }),
  }
  const args = [
    ...launcher.args,
    '--profile',
    'headless',
    ...condition.value.patches.flatMap(p => ['--patch', p]),
    '--json',
    '-',
  ]
  const agent = await runProcess(launcher.command, args, {
    cwd: workspace,
    env: { ...process.env, ...launcher.env, ...labEnv, ...condition.value.env, DSH_HOME: home },
    stdin: task.value.prompt,
    stdout: join(runDir, 'events.ndjson'),
    stderr: join(runDir, 'agent.stderr.log'),
  })

  const gates: GateResult[] = []
  for (const gate of task.value.gates) gates.push(await runGate(gate, workspace, gateLogs))

  const sessions = await Promise.all((await findSessionLogs(join(home, 'sessions'))).map(readSessionLog))
  const counted = [
    ...mergeUsage(sessions).map(u => ({ ...u, source: 'dsh-session' as const, nativeCostEstimateUsd: null })),
    ...(await readExternalUsage(join(home, 'lab-usage.jsonl'))).map(u => ({ ...u, source: 'adapter' as const })),
  ]
  const calls = sessions.flatMap(s => s.calls)
  const pricings = counted.map(u => {
    if (options.catalog === undefined) return { billing: 'unknown' as const, cost: null, peakCalls: null }
    // Session-logged calls carry their times, so each is priced at the rate then in force.
    const own = u.source === 'dsh-session' ? calls.filter(c => c.provider === u.provider && c.model === u.model) : undefined
    return priceUsage(options.catalog, u, own)
  })
  const usage = counted.map((u, i) => ({ ...u, ...pricings[i]! }))

  const record = RunRecord.parse({
    version: 1,
    runId,
    startedAt: started.toISOString(),
    task: { id: task.value.id, file: task.file },
    condition: { id: condition.value.id, file: condition.file },
    environment: {
      repoCommit: gitHead(options.repoRoot),
      node: process.version,
      platform: `${platform()}-${arch()}`,
      hostTools,
    },
    agent,
    gates,
    sessions: sessions.map(s => ({
      id: s.id,
      delegationDepth: s.delegationDepth,
      userMessages: s.userMessages,
      turns: s.turns,
    })),
    usage,
    totalCost: totalCost(pricings),
    followUpMessages: followUpMessages(sessions),
  })
  await writeFile(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}
