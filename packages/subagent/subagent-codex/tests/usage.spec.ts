import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openUsageLog } from '../src/usage-log.ts'
import { CodexAppServerWire } from '../src/wire.ts'

interface Frame {
  id?: number
  method?: string
  params?: Record<string, unknown>
}

/** Minimal app-server peer over the wire's line-delimited JSON-RPC streams. */
function peer() {
  const toWire = new PassThrough()
  const fromWire = new PassThrough()
  const frames: Frame[] = []
  const waiters: Array<() => void> = []
  let buffer = ''
  fromWire.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      frames.push(JSON.parse(buffer.slice(0, newline)) as Frame)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      for (const wake of waiters.splice(0)) wake()
    }
  })
  return {
    toWire,
    fromWire,
    async next(method: string): Promise<Frame> {
      for (;;) {
        const index = frames.findIndex(f => f.method === method)
        if (index >= 0) return frames.splice(index, 1)[0] as Frame
        await new Promise<void>(resolve => waiters.push(resolve))
      }
    },
    send(...messages: object[]) {
      for (const message of messages) toWire.write(`${JSON.stringify(message)}\n`)
    },
  }
}

const usage = (threadId: string, inputTokens: number) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId,
    turnId: 'turn-1',
    tokenUsage: {
      total: { inputTokens, cachedInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: inputTokens + 50 },
      last: { inputTokens, cachedInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: inputTokens + 50 },
    },
  },
})

async function startedWire(threadStartResult: Record<string, unknown>) {
  const p = peer()
  const wire = new CodexAppServerWire(p.toWire, p.fromWire, 'never')
  wire.start()
  const initializing = wire.initialize(new AbortController().signal)
  p.send({ id: (await p.next('initialize')).id, result: {} })
  await initializing
  const starting = wire.startThread('/workspace', new AbortController().signal)
  p.send({ id: (await p.next('thread/start')).id, result: threadStartResult })
  await starting
  return { p, wire }
}

let dir: string | undefined
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('usage accounting', () => {
  it('keeps the latest usage of its own thread with the thread model', async () => {
    const { p, wire } = await startedWire({
      thread: { id: 'thread-1', ephemeral: true },
      model: 'gpt-x',
      modelProvider: 'openai',
    })
    expect(wire.collectUsage()).toBeUndefined()
    const turn = wire.runTurn(['task'], new AbortController().signal)
    p.send({ id: (await p.next('turn/start')).id, result: { turn: { id: 'turn-1' } } })
    p.send(
      usage('thread-1', 1000),
      usage('thread-2', 9999),
      usage('thread-1', 2000),
      {
        method: 'item/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'done', phase: 'final_answer' } },
      },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
    )
    await turn
    expect(wire.collectUsage()).toEqual({
      model: 'gpt-x',
      modelProvider: 'openai',
      tokenUsage: usage('thread-1', 2000).params.tokenUsage,
    })
    wire.close()
  })

  it('reports nothing when the thread response names no model', async () => {
    const { p, wire } = await startedWire({ thread: { id: 'thread-1', ephemeral: true } })
    const turn = wire.runTurn(['task'], new AbortController().signal)
    p.send({ id: (await p.next('turn/start')).id, result: { turn: { id: 'turn-1' } } })
    p.send(
      usage('thread-1', 1000),
      {
        method: 'item/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'done', phase: 'final_answer' } },
      },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
    )
    await turn
    expect(wire.collectUsage()).toBeUndefined()
    wire.close()
  })

  it('appends records and rejects a relative usage log path', () => {
    expect(() => openUsageLog('test', 'usage.jsonl', () => {})).toThrow('usageLog must be an absolute path')
    dir = mkdtempSync(join(tmpdir(), 'usage-log-'))
    const path = join(dir, 'usage.jsonl')
    const onWriteError = vi.fn()
    openUsageLog('test', path, onWriteError)({ adapter: 'codex' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ adapter: 'codex' })
    openUsageLog('test', dir, onWriteError)({ adapter: 'codex' })
    expect(onWriteError).toHaveBeenCalledOnce()
  })
})
