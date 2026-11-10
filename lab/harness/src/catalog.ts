import { z } from 'zod'
import type { ModelUsage } from './session-log.ts'

/**
 * The fixed model catalog: prices, benchmark scores and taste ranks, filled in
 * by hand from public sources. Every figure carries its source and query date
 * so a run can be repriced and audited later.
 */

const Source = z.object({
  name: z.string().min(1),
  url: z.url(),
  queriedAt: z.iso.date(),
})

const Price = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code such as USD'),
  /** Price per million uncached input tokens. */
  inputPerMTok: z.number().nonnegative(),
  /** Price per million output tokens (reasoning tokens are part of output). */
  outputPerMTok: z.number().nonnegative(),
  /** Price per million cache-read tokens; omitted means the input price. */
  cacheReadPerMTok: z.number().nonnegative().optional(),
  /** Price per million cache-write tokens; omitted means the input price. */
  cacheWritePerMTok: z.number().nonnegative().optional(),
  source: Source,
})

const Rank = z.object({ rank: z.number().int().positive(), source: Source })

const CatalogModel = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  price: Price,
  benchmarks: z.array(z.object({ name: z.string().min(1), score: z.number(), source: Source })).default([]),
  taste: z.object({ visual: Rank.optional(), copy: Rank.optional() }).default({}),
})

export const ModelCatalog = z
  .object({
    version: z.literal(1),
    models: z.array(CatalogModel),
  })
  .refine(
    c => new Set(c.models.map(m => `${m.provider}/${m.model}`)).size === c.models.length,
    'each provider/model pair may appear only once',
  )
export type ModelCatalog = z.output<typeof ModelCatalog>

export interface Cost {
  currency: string
  amount: number
}

/**
 * Prices one model's usage with the catalog.
 * @param catalog - the model catalog.
 * @param usage - token usage of one provider/model pair.
 * @returns the cost, or null when the catalog has no price for that model.
 */
export function priceUsage(catalog: ModelCatalog, usage: ModelUsage): Cost | null {
  const entry = catalog.models.find(m => m.provider === usage.provider && m.model === usage.model)
  if (entry === undefined) return null
  const p = entry.price
  const perToken = (perMTok: number) => perMTok / 1_000_000
  const amount =
    usage.inputTokens * perToken(p.inputPerMTok) +
    usage.cacheReadTokens * perToken(p.cacheReadPerMTok ?? p.inputPerMTok) +
    usage.cacheWriteTokens * perToken(p.cacheWritePerMTok ?? p.inputPerMTok) +
    usage.outputTokens * perToken(p.outputPerMTok)
  return { currency: p.currency, amount }
}

/**
 * Sums priced usage into one total.
 * @param costs - per-model costs, null where a model was unpriced.
 * @returns the total, or null when any model is unpriced or currencies differ.
 */
export function totalCost(costs: readonly (Cost | null)[]): Cost | null {
  if (costs.length === 0) return null
  const known = costs.filter((c): c is Cost => c !== null)
  if (known.length !== costs.length) return null
  const currency = known[0]!.currency
  if (known.some(c => c.currency !== currency)) return null
  return { currency, amount: known.reduce((sum, c) => sum + c.amount, 0) }
}
