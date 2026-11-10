import { z } from 'zod'

/** The `run.json` written for every run; the unit the paper's tables are built from. */

const Cost = z.object({ currency: z.string(), amount: z.number().nonnegative() })

export const GateResult = z.object({
  id: z.string(),
  passed: z.boolean(),
  exitCode: z.number().int().nullable(),
  wallMs: z.number().int().nonnegative(),
})
export type GateResult = z.output<typeof GateResult>

export const RunRecord = z.object({
  version: z.literal(1),
  runId: z.string(),
  startedAt: z.iso.datetime(),
  task: z.object({ id: z.string(), file: z.string() }),
  condition: z.object({ id: z.string(), file: z.string() }),
  environment: z.object({
    /** Commit of this repository the run used; null outside a git checkout. */
    repoCommit: z.string().nullable(),
    node: z.string(),
    platform: z.string(),
    hostTools: z.object({
      claudeCode: z.object({ path: z.string(), version: z.string() }).nullable(),
      codexBundled: z.string().nullable(),
    }),
  }),
  agent: z.object({
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    wallMs: z.number().int().nonnegative(),
  }),
  gates: z.array(GateResult),
  sessions: z.array(
    z.object({
      id: z.string(),
      delegationDepth: z.number().int().nonnegative(),
      userMessages: z.number().int().nonnegative(),
      turns: z.number().int().nonnegative(),
    }),
  ),
  usage: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      calls: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(),
      reasoningTokens: z.number().int().nonnegative(),
      /** Where the tokens were counted: a DSH session log, or a delegation adapter's usage log. */
      source: z.enum(['dsh-session', 'adapter']),
      billing: z.enum(['per-token', 'subscription', 'unknown']),
      /** Cash cost; null for subscription and uncatalogued models. */
      cost: Cost.nullable(),
      /** Calls billed at peak rates; null unless billed per token. */
      peakCalls: z.number().int().nonnegative().nullable(),
      /** Claude Code's own USD estimate for subscription runs; not a bill. */
      nativeCostEstimateUsd: z.number().nonnegative().nullable(),
    }),
  ),
  /** Cash cost of per-token models; null when a model is uncatalogued, currencies differ, or none is per-token. */
  totalCost: Cost.nullable(),
  /** Messages a person sent after the initial task: the human-attention measure. */
  followUpMessages: z.number().int().nonnegative(),
})
export type RunRecord = z.output<typeof RunRecord>
