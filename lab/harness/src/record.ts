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
      cost: Cost.nullable(),
    }),
  ),
  /** Null when no catalog was given, a model was unpriced, or currencies differ. */
  totalCost: Cost.nullable(),
  /** Messages a person sent after the initial task: the human-attention measure. */
  followUpMessages: z.number().int().nonnegative(),
})
export type RunRecord = z.output<typeof RunRecord>
