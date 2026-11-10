import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLogError, findSessionLogs, followUpMessages, readSessionLog } from '../src/session-log.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lab-sessions-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(path: string, lines: object[]) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), lines.map(l => JSON.stringify(l)).join('\n'))
}

describe('findSessionLogs', () => {
  it('picks the highest raw generation of each session', async () => {
    await put('--p--/a/session.v2.jsonl', [])
    await put('--p--/a/session.v3.jsonl', [])
    await put('--p--/b/session.jsonl', [])
    expect(await findSessionLogs(root)).toEqual([
      join(root, '--p--/a/session.v3.jsonl'),
      join(root, '--p--/b/session.jsonl'),
    ])
  })

  it('returns nothing when the sessions root does not exist', async () => {
    expect(await findSessionLogs(join(root, 'missing'))).toEqual([])
  })

  it('fails loudly on compressed-only sessions', async () => {
    await mkdir(join(root, '--p--/c'), { recursive: true })
    await writeFile(join(root, '--p--/c/session.v3.jsonl.zstd'), '')
    await expect(findSessionLogs(root)).rejects.toThrow(SessionLogError)
  })
})

describe('readSessionLog', () => {
  it('counts messages and sums usage per model, ignoring non-model sources', async () => {
    await put('--p--/a/session.v3.jsonl', [
      { type: 'session', id: 'a', delegationDepth: 0 },
      { type: 'user/message', data: { source: { kind: 'user' } } },
      { type: 'user/message', data: { source: { kind: 'runtime-context' } } },
      { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 5, outputTokens: 7, reasoningTokens: 3 } } },
      { type: 'assistant/message', data: { message: { source: { kind: 'user' } }, usage: { inputTokens: 99 } } },
      { type: 'turn/end', data: {} },
      { type: 'user/message', data: { source: { kind: 'user' } } },
    ])
    const summary = await readSessionLog(join(root, '--p--/a/session.v3.jsonl'))
    expect(summary).toMatchObject({ id: 'a', delegationDepth: 0, userMessages: 2, turns: 1 })
    expect(summary.usage).toEqual([
      { provider: 'p', model: 'm', calls: 1, inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 3 },
    ])
    expect(followUpMessages([summary, { ...summary, delegationDepth: 1, userMessages: 9 }])).toBe(1)
  })

  it('names the line of malformed JSON', async () => {
    await mkdir(join(root, 'x'), { recursive: true })
    await writeFile(join(root, 'x/session.jsonl'), '{"type":"session"}\n{oops\n')
    await expect(readSessionLog(join(root, 'x/session.jsonl'))).rejects.toThrow(/session\.jsonl:2/)
  })
})
