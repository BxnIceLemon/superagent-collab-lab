import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, PluginContext, SourceContext, Trigger } from '../src/host.ts'
import { apply, conversation, labTaskKind, labTrigger, pollInbox, sendLabTask, type LabTaskConfig } from '../src/index.ts'

let dir: string
let config: LabTaskConfig
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lab-task-'))
  config = { inbox: join(dir, 'inbox.jsonl'), outbox: join(dir, 'outbox.jsonl'), pollSeconds: 2 }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const message = { id: 'task', from: 'operator', text: 'build it', at: '2026-11-10T08:00:00.000Z' }

function context(overrides: Partial<SourceContext> = {}): SourceContext & { reports: Health[] } {
  const reports: Health[] = []
  return {
    ready: Promise.resolve(),
    configured: () => true,
    config: () => config as never,
    receive: vi.fn(() => 'stored' as const),
    report: (_entry, health) => { reports.push(health) },
    reports,
    ...overrides,
  }
}

describe('labTrigger', () => {
  it('is a direct request from the operator on the task Thread, with a stable id', () => {
    const trigger = labTrigger(message, config)
    expect(trigger).toMatchObject({
      source: 'lab-task',
      threads: [{ source: 'lab-task', id: 'task' }],
      actor: { source: 'lab-task', id: 'operator' },
      human: true,
      addressed: 'direct',
      text: 'build it',
      channel: { source: 'lab-task', thread: 'lab-task:task', address: { outbox: config.outbox, message: 'task' } },
    })
    expect(trigger.id).toMatch(/^[0-9a-f]{32}$/)
    expect(labTrigger(message, config).id).toBe(trigger.id)
    expect(labTaskKind.schema.parse({})).toEqual({ inbox: '', outbox: '', pollSeconds: 2 })
  })
})

describe('sendLabTask', () => {
  it('appends each message once, however often it is sent', async () => {
    const out = { id: 'r1', kind: 'reply' as const, ticketId: 't1', text: 'Done.', channel: labTrigger(message, config).channel! }
    expect(await sendLabTask(out)).toBe('sent')
    expect(await sendLabTask(out)).toBe('sent')
    const lines = (await readFile(config.outbox, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toEqual([expect.objectContaining({ id: 'r1', kind: 'reply', ticketId: 't1', text: 'Done.' })])
  })
})

describe('pollInbox and conversation', () => {
  it('takes in every readable inbox line and shows the conversation in order', async () => {
    await writeFile(config.inbox, `${JSON.stringify(message)}\n{"id": ""}\n`)
    const ctx = context()
    expect(await pollInbox(ctx, config)).toEqual({ read: 2, unreadable: 1 })
    expect(ctx.receive).toHaveBeenCalledTimes(1)
    await writeFile(config.outbox, `${JSON.stringify({ id: 'r1', text: 'On it.', at: '2026-11-10T08:00:05.000Z' })}\n`)
    const trigger = vi.mocked(ctx.receive).mock.calls[0]![0] as Trigger
    expect(await conversation(trigger)).toEqual([
      { id: 'task', from: 'operator', at: message.at, text: 'build it' },
      { id: 'r1', from: 'agent', at: '2026-11-10T08:00:05.000Z', text: 'On it.', bot: true },
    ])
  })

  it('reads nothing before the inbox exists', async () => {
    expect(await pollInbox(context(), config)).toEqual({ read: 0, unreadable: 0 })
  })
})

describe('apply', () => {
  it('registers the kind and waits while setup is pending', async () => {
    const unregister = vi.fn()
    const effects: (() => unknown)[] = []
    const source = context({ configured: () => false })
    const ctx: PluginContext = {
      orchestrator: { sources: { register: vi.fn(() => unregister) }, context: () => source },
      effect: execute => { const dispose = execute(); if (dispose) effects.push(dispose) },
    }
    apply(ctx)
    expect(ctx.orchestrator.sources.register).toHaveBeenCalledWith(labTaskKind)
    await vi.waitFor(() => expect(source.reports).toEqual([expect.objectContaining({ state: 'paused', code: 'setupPending' })]))
    for (const dispose of effects) await dispose()
    expect(unregister).toHaveBeenCalled()
  })
})
