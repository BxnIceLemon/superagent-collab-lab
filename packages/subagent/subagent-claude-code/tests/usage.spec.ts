import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeCodeUsage, consumeClaudeQuery } from '../src/run.ts'
import { openUsageLog } from '../src/usage-log.ts'

const modelUsage = {
  'claude-sonnet-x': {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: 40,
    webSearchRequests: 0,
    costUSD: 0.5,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
}

function result(text: string): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: 0.5,
    modelUsage,
  } as unknown as SDKResultMessage
}

async function* stream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  yield* messages
}

let dir: string | undefined
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('usage accounting', () => {
  it('projects the native cost estimate and per-model counts unchanged', () => {
    expect(claudeCodeUsage(result('done'))).toEqual({ totalCostUsd: 0.5, modelUsage })
  })

  it('hands every terminal result message to onResult', async () => {
    const onResult = vi.fn()
    const first = result('first')
    const last = result('last')
    await consumeClaudeQuery(stream([first, last]), undefined, onResult)
    expect(onResult.mock.calls).toEqual([[first], [last]])
  })

  it('appends one timestamped JSON line per record', () => {
    dir = mkdtempSync(join(tmpdir(), 'usage-log-'))
    const path = join(dir, 'nested', 'usage.jsonl')
    const write = openUsageLog('test', path, () => {
      throw new Error('unexpected write failure')
    })
    write({ adapter: 'claude-code', n: 1 })
    write({ adapter: 'claude-code', n: 2 })
    const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(l => l.n)).toEqual([1, 2])
    expect(typeof lines[0]?.at).toBe('string')
  })

  it('rejects a relative path at load and reports later append failures', () => {
    expect(() => openUsageLog('test', 'usage.jsonl', () => {})).toThrow('usageLog must be an absolute path')
    dir = mkdtempSync(join(tmpdir(), 'usage-log-'))
    const onWriteError = vi.fn()
    // A directory cannot be appended to, so the write fails after load.
    const write = openUsageLog('test', dir, onWriteError)
    write({ adapter: 'claude-code' })
    expect(onWriteError).toHaveBeenCalledOnce()
    expect(onWriteError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })
})
