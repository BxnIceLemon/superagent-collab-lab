import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Reads DSH JSONL session logs (`<root>/<project>/<session>/session.vN.jsonl`)
 * and reduces them to the figures the lab reports. Runs must keep logs
 * uncompressed; see `conditions/patches/plain-session-log.yml`.
 */

export interface ModelUsage {
  provider: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface SessionSummary {
  id: string
  file: string
  /** 0 for a session a person started, higher for delegated children. */
  delegationDepth: number
  /** `user/message` events whose source kind is "user". */
  userMessages: number
  turns: number
  usage: ModelUsage[]
}

/** A session log that cannot be read as the lab expects. */
export class SessionLogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionLogError'
  }
}

const RAW_LOG = /^session(?:\.v(\d+))?\.jsonl$/
const COMPRESSED_LOG = /^session(?:\.v\d+)?\.jsonl\.(?:zstd|gz)$/

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => join(path, e.name))
  } catch (error) {
    // A run that never created a session has no sessions root.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Finds the current-generation log of every session under a sessions root.
 * @param root - the `sessions` directory of a DSH home.
 * @returns one log path per session, sorted.
 */
export async function findSessionLogs(root: string): Promise<string[]> {
  const logs: string[] = []
  for (const project of await listDirs(root)) {
    for (const session of await listDirs(project)) {
      const names = await readdir(session)
      let best: { name: string; version: number } | undefined
      for (const name of names) {
        const match = RAW_LOG.exec(name)
        if (match === null) continue
        const version = match[1] === undefined ? 0 : Number(match[1])
        if (best === undefined || version > best.version) best = { name, version }
      }
      if (best !== undefined) logs.push(join(session, best.name))
      else if (names.some(n => COMPRESSED_LOG.test(n)))
        throw new SessionLogError(`${session}: only compressed logs found; run with the plain-session-log patch`)
    }
  }
  return logs.sort()
}

interface RawEvent {
  type?: unknown
  id?: unknown
  delegationDepth?: unknown
  data?: {
    usage?: Record<string, unknown>
    source?: { kind?: unknown }
    message?: { source?: { kind?: unknown; provider?: unknown; model?: unknown } }
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Reduces one session log to its summary.
 * @param file - path of a raw JSONL session log.
 * @returns the session's message counts and per-model token usage.
 */
export async function readSessionLog(file: string): Promise<SessionSummary> {
  const lines = (await readFile(file, 'utf8')).split('\n')
  const summary: SessionSummary = { id: '', file, delegationDepth: 0, userMessages: 0, turns: 0, usage: [] }
  const byModel = new Map<string, ModelUsage>()
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    let event: RawEvent
    try {
      event = JSON.parse(line) as RawEvent
    } catch {
      throw new SessionLogError(`${file}:${index + 1}: not valid JSON`)
    }
    switch (event.type) {
      case 'session':
        summary.id = String(event.id ?? '')
        summary.delegationDepth = count(event.delegationDepth)
        break
      case 'user/message':
        // Plugins also append user-role messages (runtime context, notices);
        // only kind "user" is text a person or the launching caller sent.
        if (event.data?.source?.kind === 'user') summary.userMessages += 1
        break
      case 'turn/end':
        summary.turns += 1
        break
      case 'assistant/message': {
        const source = event.data?.message?.source
        const usage = event.data?.usage
        if (source?.kind !== 'model' || usage === undefined) break
        const provider = String(source.provider)
        const model = String(source.model)
        const key = `${provider}/${model}`
        const entry = byModel.get(key) ?? {
          provider,
          model,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        }
        entry.calls += 1
        entry.inputTokens += count(usage.inputTokens)
        entry.outputTokens += count(usage.outputTokens)
        entry.cacheReadTokens += count(usage.cacheReadTokens)
        entry.cacheWriteTokens += count(usage.cacheWriteTokens)
        entry.reasoningTokens += count(usage.reasoningTokens)
        byModel.set(key, entry)
        break
      }
      default:
        // Other event types carry nothing the lab measures.
        break
    }
  })
  summary.usage = [...byModel.values()]
  return summary
}

/**
 * Merges the usage of several sessions per provider/model pair.
 * @param sessions - session summaries.
 * @returns combined usage, sorted by provider/model.
 */
export function mergeUsage(sessions: readonly SessionSummary[]): ModelUsage[] {
  const merged = new Map<string, ModelUsage>()
  for (const usage of sessions.flatMap(s => s.usage)) {
    const key = `${usage.provider}/${usage.model}`
    const entry = merged.get(key)
    if (entry === undefined) {
      merged.set(key, { ...usage })
      continue
    }
    entry.calls += usage.calls
    entry.inputTokens += usage.inputTokens
    entry.outputTokens += usage.outputTokens
    entry.cacheReadTokens += usage.cacheReadTokens
    entry.cacheWriteTokens += usage.cacheWriteTokens
    entry.reasoningTokens += usage.reasoningTokens
  }
  return [...merged.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
}

/**
 * Counts the messages a person sent after the initial task, across root sessions.
 * @param sessions - session summaries.
 * @returns follow-up messages from a person; the lab's measure of human attention.
 */
export function followUpMessages(sessions: readonly SessionSummary[]): number {
  return sessions
    .filter(s => s.delegationDepth === 0)
    .reduce((sum, s) => sum + Math.max(0, s.userMessages - 1), 0)
}
