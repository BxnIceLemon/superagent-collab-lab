/**
 * Optional JSONL accounting sink for delegated runs. Each settled run with a
 * terminal usage report appends one line; nothing reaches the model.
 *
 * @module
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

/** Writes one usage record per line. */
export type UsageLogWriter = (record: Readonly<Record<string, unknown>>) => void

/**
 * Open a usage log, creating its directory at load so a bad path fails loud.
 * @param owner - package name used in error text.
 * @param path - absolute JSONL path.
 * @param onWriteError - receives a later append failure; the run itself is unaffected.
 * @returns the line writer.
 */
export function openUsageLog(
  owner: string,
  path: string,
  onWriteError: (error: Error) => void,
): UsageLogWriter {
  if (!isAbsolute(path)) throw new Error(`${owner}: usageLog must be an absolute path`)
  mkdirSync(dirname(path), { recursive: true })
  return (record) => {
    try {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
    } catch (error: unknown) {
      onWriteError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
