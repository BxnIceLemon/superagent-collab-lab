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

const Rates = z.object({
  /** Price per million uncached input tokens. */
  inputPerMTok: z.number().nonnegative(),
  /** Price per million output tokens (reasoning tokens are part of output). */
  outputPerMTok: z.number().nonnegative(),
  /** Price per million cache-read tokens; omitted means the input price. */
  cacheReadPerMTok: z.number().nonnegative().optional(),
  /** Price per million cache-write tokens; omitted means the input price. */
  cacheWritePerMTok: z.number().nonnegative().optional(),
})
export type Rates = z.output<typeof Rates>

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour')

const Price = Rates.extend({
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code such as USD'),
  /** Rates that replace the base rates inside the listed UTC windows. */
  peak: Rates.extend({
    windows: z
      .array(
        z.object({
          /** ISO weekdays, 1 = Monday ... 7 = Sunday, in UTC. */
          weekdays: z.array(z.number().int().min(1).max(7)).min(1),
          /** Window start, inclusive, UTC. */
          start: HHMM,
          /** Window end, exclusive, UTC. */
          end: HHMM,
        }),
      )
      .min(1),
    /** UTC dates billed at base rates all day, such as public holidays. */
    exceptDates: z.array(z.iso.date()).default([]),
  }).optional(),
  source: Source,
})
export type Price = z.output<typeof Price>

const Rank = z.object({
  source: Source,
  /** The leaderboard entry as displayed, including its reasoning setting. */
  entry: z.string().min(1),
  rank: z.number().int().positive(),
  /** Upper bound when the leaderboard shows a rank range. */
  rankUpper: z.number().int().positive().optional(),
  score: z.number(),
})

const CatalogModel = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    /**
     * `per-token`: paid per token at `price`. `subscription`: used through a
     * flat plan (`plan`), so tokens are recorded but cost no marginal cash.
     */
    billing: z.enum(['per-token', 'subscription']).default('per-token'),
    price: Price.optional(),
    plan: z
      .object({
        name: z.string().min(1),
        monthlyPrice: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount: z.number().nonnegative() }).optional(),
        source: Source,
      })
      .optional(),
    benchmarks: z.array(z.object({ name: z.string().min(1), score: z.number(), source: Source })).default([]),
    /** Public leaderboard placements; several boards may rank one model. */
    taste: z.object({ visual: z.array(Rank).default([]), copy: z.array(Rank).default([]) }).default({ visual: [], copy: [] }),
  })
  .refine(m => (m.billing === 'per-token' ? m.price !== undefined : m.plan !== undefined), {
    message: 'per-token models need price; subscription models need plan',
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

export type Pricing =
  /** `peakCalls`: calls billed at peak rates. */
  | { billing: 'per-token'; cost: Cost; peakCalls: number }
  | { billing: 'subscription'; cost: null; peakCalls: null }
  | { billing: 'unknown'; cost: null; peakCalls: null }

/** Token counts of one model call, with its time (epoch ms) when known. */
export interface TimedTokens {
  time: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Whether a call falls in a peak window. A call without a time is billed at
 * peak rates, so a missing timestamp can only overstate cost.
 * @param price - the model's price.
 * @param time - call time in epoch ms, or null.
 * @returns true when peak rates apply.
 */
export function isPeak(price: Price, time: number | null): boolean {
  const peak = price.peak
  if (peak === undefined) return false
  if (time === null) return true
  const at = new Date(time)
  if (peak.exceptDates.includes(at.toISOString().slice(0, 10))) return false
  const weekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay()
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes()
  const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
  return peak.windows.some(w => w.weekdays.includes(weekday) && minute >= toMinute(w.start) && minute < toMinute(w.end))
}

function costOf(rates: Rates, t: TimedTokens): number {
  const perToken = (perMTok: number) => perMTok / 1_000_000
  return (
    t.inputTokens * perToken(rates.inputPerMTok) +
    t.cacheReadTokens * perToken(rates.cacheReadPerMTok ?? rates.inputPerMTok) +
    t.cacheWriteTokens * perToken(rates.cacheWritePerMTok ?? rates.inputPerMTok) +
    t.outputTokens * perToken(rates.outputPerMTok)
  )
}

/**
 * Prices one model's usage with the catalog, call by call when calls are given.
 * @param catalog - the model catalog.
 * @param usage - token usage of one provider/model pair.
 * @param calls - the individual calls behind `usage`; without them the total is priced as one untimed call.
 * @returns the cash cost for per-token models; no cost for subscription or uncatalogued models.
 */
export function priceUsage(catalog: ModelCatalog, usage: ModelUsage, calls?: readonly TimedTokens[]): Pricing {
  const entry = catalog.models.find(m => m.provider === usage.provider && m.model === usage.model)
  if (entry === undefined) return { billing: 'unknown', cost: null, peakCalls: null }
  if (entry.billing === 'subscription' || entry.price === undefined) return { billing: 'subscription', cost: null, peakCalls: null }
  const price = entry.price
  const items = calls ?? [{ ...usage, time: null }]
  let amount = 0
  let peakCalls = 0
  for (const call of items) {
    const peak = isPeak(price, call.time)
    if (peak) peakCalls += 1
    amount += costOf(peak && price.peak !== undefined ? price.peak : price, call)
  }
  return { billing: 'per-token', cost: { currency: price.currency, amount }, peakCalls }
}

/**
 * Sums the cash cost of a run's per-token models; subscription models add nothing.
 * @param pricings - one pricing per model used.
 * @returns the total, or null when any model is uncatalogued, currencies differ, or nothing is per-token.
 */
export function totalCost(pricings: readonly Pricing[]): Cost | null {
  if (pricings.some(p => p.billing === 'unknown')) return null
  const costs = pricings.flatMap(p => (p.billing === 'per-token' ? [p.cost] : []))
  if (costs.length === 0) return null
  const currency = costs[0]!.currency
  if (costs.some(c => c.currency !== currency)) return null
  return { currency, amount: costs.reduce((sum, c) => sum + c.amount, 0) }
}
