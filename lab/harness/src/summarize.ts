import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RunRecord } from './record.ts'

/**
 * Reads every `run.json` under a results directory.
 * @param resultsDir - directory holding one sub-directory per run.
 * @returns the run records, oldest first.
 */
export async function readRuns(resultsDir: string): Promise<RunRecord[]> {
  const entries = await readdir(resultsDir, { withFileTypes: true })
  const runs: RunRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(resultsDir, entry.name, 'run.json')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      // A run directory without run.json is a run that crashed before recording.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    runs.push(RunRecord.parse(JSON.parse(text)))
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

const COLUMNS = [
  'run',
  'task',
  'condition',
  'exit',
  'gates passed',
  'wall s',
  'input tok',
  'cache-read tok',
  'output tok',
  'cost',
  'sessions',
  'follow-ups',
] as const

function row(run: RunRecord): string[] {
  const sum = (key: 'inputTokens' | 'cacheReadTokens' | 'outputTokens') =>
    String(run.usage.reduce((total, u) => total + u[key], 0))
  const passed = run.gates.filter(g => g.passed).length
  return [
    run.runId,
    run.task.id,
    run.condition.id,
    run.agent.code === null ? `signal ${run.agent.signal}` : String(run.agent.code),
    `${passed}/${run.gates.length}`,
    (run.agent.wallMs / 1000).toFixed(1),
    sum('inputTokens'),
    sum('cacheReadTokens'),
    sum('outputTokens'),
    run.totalCost === null ? 'n/a' : `${run.totalCost.amount.toFixed(4)} ${run.totalCost.currency}`,
    String(run.sessions.length),
    String(run.followUpMessages),
  ]
}

/**
 * Formats runs as a Markdown table.
 * @param runs - run records.
 * @returns the table text.
 */
export function toMarkdown(runs: readonly RunRecord[]): string {
  const lines = [`| ${COLUMNS.join(' | ')} |`, `| ${COLUMNS.map(() => '---').join(' | ')} |`]
  for (const run of runs) lines.push(`| ${row(run).join(' | ')} |`)
  return `${lines.join('\n')}\n`
}

/**
 * Formats runs as CSV.
 * @param runs - run records.
 * @returns the CSV text.
 */
export function toCsv(runs: readonly RunRecord[]): string {
  const quote = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)
  return `${[COLUMNS.join(','), ...runs.map(r => row(r).map(quote).join(','))].join('\n')}\n`
}
