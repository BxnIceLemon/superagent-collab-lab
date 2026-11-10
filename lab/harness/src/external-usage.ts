import { readFile } from 'node:fs/promises'
import type { ModelUsage } from './session-log.ts'

/**
 * Reads `<DSH_HOME>/lab-usage.jsonl`, written by the Claude Code and Codex
 * delegation adapters (`usageLog`), and converts each native report to the
 * lab's disjoint token counts. Those children run outside DSH, so their
 * tokens never appear in DSH session logs.
 */

export interface ExternalUsage extends ModelUsage {
  /** Claude Code's own USD estimate, when the adapter reported one; not a bill. */
  nativeCostEstimateUsd: number | null
}

/** A usage log line the harness cannot interpret. */
export class ExternalUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExternalUsageError'
  }
}

type Json = Record<string, unknown>

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function empty(provider: string, model: string): ExternalUsage {
  return {
    provider,
    model,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    nativeCostEstimateUsd: null,
  }
}

/**
 * Claude Agent SDK `modelUsage`: input excludes cache reads and writes;
 * thinking tokens are already inside output.
 */
function fromClaude(record: Json, add: (u: ExternalUsage) => void): void {
  const models = record.modelUsage
  if (typeof models !== 'object' || models === null) throw new ExternalUsageError('claude-code record without modelUsage')
  const entries = Object.entries(models as Record<string, Json>)
  const total = num(record.totalCostUsd)
  const modelCost = entries.reduce((sum, [, m]) => sum + num(m.costUSD), 0)
  for (const [model, m] of entries) {
    add({
      ...empty('claude-code', model),
      calls: 1,
      inputTokens: num(m.inputTokens),
      outputTokens: num(m.outputTokens),
      cacheReadTokens: num(m.cacheReadInputTokens),
      cacheWriteTokens: num(m.cacheCreationInputTokens),
      reasoningTokens: num(m.thinkingTokens),
      // Prefer the per-model figure; fall back to the run total for a single model.
      nativeCostEstimateUsd: modelCost > 0 ? num(m.costUSD) : entries.length === 1 ? total : null,
    })
  }
}

/**
 * Codex app-server `tokenUsage.total`: input includes cached input (OpenAI
 * convention), so uncached input is input minus cached.
 */
function fromCodex(record: Json, add: (u: ExternalUsage) => void): void {
  const usage = record.tokenUsage as Json | undefined
  const total = usage?.total as Json | undefined
  if (typeof record.model !== 'string' || total === undefined) throw new ExternalUsageError('codex record without model or tokenUsage.total')
  const cached = num(total.cachedInputTokens)
  add({
    ...empty('codex', record.model),
    calls: 1,
    inputTokens: Math.max(0, num(total.inputTokens) - cached),
    outputTokens: num(total.outputTokens),
    cacheReadTokens: cached,
    cacheWriteTokens: num(total.cacheWriteInputTokens),
    reasoningTokens: num(total.reasoningOutputTokens),
  })
}

/**
 * Reads and merges the adapters' usage log.
 * @param file - path of `lab-usage.jsonl`.
 * @returns usage per provider/model; empty when no delegation ran.
 */
export async function readExternalUsage(file: string): Promise<ExternalUsage[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    // No delegation to Claude Code or Codex happened in this run.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const merged = new Map<string, ExternalUsage>()
  const add = (u: ExternalUsage) => {
    const key = `${u.provider}/${u.model}`
    const entry = merged.get(key)
    if (entry === undefined) {
      merged.set(key, { ...u })
      return
    }
    entry.calls += u.calls
    entry.inputTokens += u.inputTokens
    entry.outputTokens += u.outputTokens
    entry.cacheReadTokens += u.cacheReadTokens
    entry.cacheWriteTokens += u.cacheWriteTokens
    entry.reasoningTokens += u.reasoningTokens
    if (u.nativeCostEstimateUsd !== null) entry.nativeCostEstimateUsd = (entry.nativeCostEstimateUsd ?? 0) + u.nativeCostEstimateUsd
  }
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return
    let record: Json
    try {
      record = JSON.parse(line) as Json
    } catch {
      throw new ExternalUsageError(`${file}:${index + 1}: not valid JSON`)
    }
    try {
      if (record.adapter === 'claude-code') fromClaude(record, add)
      else if (record.adapter === 'codex') fromCodex(record, add)
      else throw new ExternalUsageError(`unknown adapter ${JSON.stringify(record.adapter)}`)
    } catch (error) {
      throw new ExternalUsageError(`${file}:${index + 1}: ${(error as Error).message}`)
    }
  })
  return [...merged.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
}
