import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ModelCatalog, priceUsage, totalCost } from '../src/catalog.ts'
import { loadCondition, loadTask } from '../src/experiment.ts'
import { readDocument } from '../src/files.ts'
import { TaskSheet, Ticket } from '../src/protocol.ts'

const lab = fileURLToPath(new URL('../../', import.meta.url))
const source = { name: 'test', url: 'https://example.com', queriedAt: '2026-11-10' }

describe('shipped experiment files', () => {
  it('validate', async () => {
    for (const name of await readdir(join(lab, 'tasks'))) await loadTask(join(lab, 'tasks', name))
    for (const name of (await readdir(join(lab, 'conditions'))).filter(n => n.endsWith('.yaml'))) {
      const condition = await loadCondition(join(lab, 'conditions', name))
      for (const patch of condition.value.patches) expect(patch.startsWith(join(lab, 'conditions'))).toBe(true)
    }
    await readDocument(join(lab, 'catalog/models.yaml'), ModelCatalog)
  })
})

describe('catalog', () => {
  const usage = { provider: 'p', model: 'm', calls: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, reasoningTokens: 0 }

  it('prices cache reads at the input price when no cache price is given', () => {
    const catalog = ModelCatalog.parse({ version: 1, models: [{ provider: 'p', model: 'm', price: { currency: 'USD', inputPerMTok: 2, outputPerMTok: 8, source } }] })
    expect(priceUsage(catalog, usage)).toEqual({ billing: 'per-token', cost: { currency: 'USD', amount: 4 }, peakCalls: 0 })
    expect(priceUsage(catalog, { ...usage, model: 'other' })).toEqual({ billing: 'unknown', cost: null, peakCalls: null })
  })

  it('prices each call at the rate in force at its time', () => {
    const catalog = ModelCatalog.parse({
      version: 1,
      models: [
        {
          provider: 'p',
          model: 'm',
          price: {
            currency: 'USD',
            inputPerMTok: 1,
            outputPerMTok: 1,
            peak: {
              inputPerMTok: 2,
              outputPerMTok: 2,
              windows: [{ weekdays: [1, 2, 3, 4, 5], start: '01:00', end: '04:00' }],
              exceptDates: ['2026-10-01'],
            },
            source,
          },
        },
      ],
    })
    const call = (iso: string) => ({ time: Date.parse(iso), inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    const calls = [
      call('2026-11-10T01:00:00Z'), // Tuesday, window start: peak
      call('2026-11-10T04:00:00Z'), // window end is exclusive: base
      call('2026-11-14T02:00:00Z'), // Saturday: base
      call('2026-10-01T02:00:00Z'), // Thursday, excepted date: base
      { ...call('2026-11-10T02:00:00Z'), time: null }, // untimed: peak
    ]
    expect(priceUsage(catalog, { ...usage, calls: 5 }, calls)).toEqual({
      billing: 'per-token',
      cost: { currency: 'USD', amount: 2 + 1 + 1 + 1 + 2 },
      peakCalls: 2,
    })
  })

  it('records subscription models without cash cost', () => {
    const catalog = ModelCatalog.parse({ version: 1, models: [{ provider: 'p', model: 'm', billing: 'subscription', plan: { name: 'Plan', source } }] })
    expect(priceUsage(catalog, usage)).toEqual({ billing: 'subscription', cost: null, peakCalls: null })
    expect(ModelCatalog.safeParse({ version: 1, models: [{ provider: 'p', model: 'm', billing: 'subscription' }] }).success).toBe(false)
    expect(ModelCatalog.safeParse({ version: 1, models: [{ provider: 'p', model: 'm' }] }).success).toBe(false)
  })

  it('totals per-token cost in one currency and fails on uncatalogued models', () => {
    const usd = (amount: number) => ({ billing: 'per-token' as const, cost: { currency: 'USD', amount }, peakCalls: 0 })
    const sub = { billing: 'subscription' as const, cost: null, peakCalls: null }
    expect(totalCost([usd(1), usd(2), sub])).toEqual({ currency: 'USD', amount: 3 })
    expect(totalCost([usd(1), { billing: 'unknown', cost: null, peakCalls: null }])).toBeNull()
    expect(totalCost([usd(1), { billing: 'per-token', cost: { currency: 'CNY', amount: 1 }, peakCalls: 0 }])).toBeNull()
    expect(totalCost([sub])).toBeNull()
    expect(totalCost([])).toBeNull()
  })

  it('rejects duplicate models', () => {
    const entry = { provider: 'p', model: 'm', price: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 1, source } }
    expect(ModelCatalog.safeParse({ version: 1, models: [entry, entry] }).success).toBe(false)
  })
})

describe('protocol', () => {
  it('accepts a task sheet and fills defaults', () => {
    const sheet = TaskSheet.parse({
      version: 1,
      id: 'p1.login-form',
      phase: 'mvp',
      goal: 'Login form posts to /api/session',
      priority: 'P0',
      taskType: 'frontend',
      difficulty: 2,
      contractVersion: '1',
      acceptanceCriteria: ['e2e login test passes'],
    })
    expect(sheet.constraints).toEqual([])
    expect(sheet.related).toEqual([])
  })

  it('rejects a ticket whose rework exceeds its limit', () => {
    const ticket = { version: 1, taskId: 'p1.login-form', status: 'completed', rework: { used: 3, limit: 2 } }
    expect(Ticket.safeParse(ticket).success).toBe(false)
    expect(Ticket.safeParse({ ...ticket, rework: { used: 2, limit: 2 } }).success).toBe(true)
  })
})
