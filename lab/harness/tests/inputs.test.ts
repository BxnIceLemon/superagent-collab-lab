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
    expect(priceUsage(catalog, usage)).toEqual({ currency: 'USD', amount: 4 })
    expect(priceUsage(catalog, { ...usage, model: 'other' })).toBeNull()
  })

  it('totals only when every model is priced in one currency', () => {
    expect(totalCost([{ currency: 'USD', amount: 1 }, { currency: 'USD', amount: 2 }])).toEqual({ currency: 'USD', amount: 3 })
    expect(totalCost([{ currency: 'USD', amount: 1 }, null])).toBeNull()
    expect(totalCost([{ currency: 'USD', amount: 1 }, { currency: 'CNY', amount: 1 }])).toBeNull()
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
