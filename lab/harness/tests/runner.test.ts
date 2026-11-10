import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelCatalog } from '../src/catalog.ts'
import { runExperiment } from '../src/runner.ts'
import { readRuns, toCsv, toMarkdown } from '../src/summarize.ts'

const fakeDsh = fileURLToPath(new URL('fixtures/fake-dsh.mjs', import.meta.url))
const source = { name: 'test', url: 'https://example.com', queriedAt: '2026-11-10' }

const catalog = ModelCatalog.parse({
  version: 1,
  models: [
    { provider: 'p', model: 'strong', price: { currency: 'USD', inputPerMTok: 10, outputPerMTok: 20, cacheReadPerMTok: 1, source } },
    { provider: 'p', model: 'cheap', price: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 2, source } },
    { provider: 'claude-code', model: 'claude-x', billing: 'subscription', plan: { name: 'Claude plan', source } },
    { provider: 'codex', model: 'gpt-x', billing: 'subscription', plan: { name: 'ChatGPT plan', source } },
  ],
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lab-runner-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runExperiment', () => {
  it('runs the agent, the gates and records usage, cost and attention', async () => {
    const record = await runExperiment({
      repoRoot: dir,
      resultsDir: join(dir, 'results'),
      task: {
        file: '/tasks/t.yaml',
        value: {
          version: 1,
          id: 't-x',
          title: 'x',
          prompt: 'build it',
          gates: [
            { id: 'readme', run: 'test -s README.md', timeoutSec: 10 },
            { id: 'pkg', run: 'test -s package.json', timeoutSec: 10 },
          ],
        },
      },
      condition: {
        file: '/conditions/c.yaml',
        value: { version: 1, id: 'c-x', description: 'x', launcher: 'dsh-headless', patches: ['/p.yml'], env: {} },
      },
      catalog,
      launcher: { command: process.execPath, args: [fakeDsh], env: {} },
      hostTools: { claudeCode: { path: '/opt/claude', version: '9.9.9' }, codexBundled: '0.0.1' },
      now: () => new Date('2026-11-10T08:00:00.000Z'),
    })

    expect(record.runId).toBe('20261110T080000Z-t-x-c-x')
    expect(record.agent.code).toBe(0)
    expect(record.gates.map(g => [g.id, g.passed])).toEqual([
      ['readme', true],
      ['pkg', false],
    ])
    expect(record.sessions).toHaveLength(2)
    expect(record.followUpMessages).toBe(0)
    expect(record.usage).toEqual([
      expect.objectContaining({ model: 'cheap', calls: 2, inputTokens: 3000, outputTokens: 500, source: 'dsh-session', billing: 'per-token' }),
      expect.objectContaining({ model: 'strong', calls: 1, inputTokens: 100, cacheReadTokens: 1000, billing: 'per-token' }),
      expect.objectContaining({
        provider: 'claude-code',
        model: 'claude-x',
        inputTokens: 10,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
        outputTokens: 20,
        source: 'adapter',
        billing: 'subscription',
        cost: null,
        nativeCostEstimateUsd: 0.25,
      }),
      // Codex input includes cached input; the harness stores uncached input only.
      expect.objectContaining({
        provider: 'codex',
        model: 'gpt-x',
        inputTokens: 400,
        cacheReadTokens: 600,
        outputTokens: 70,
        reasoningTokens: 30,
        billing: 'subscription',
      }),
    ])
    // cheap: 3000*1e-6 + 500*2e-6 = 0.004; strong: 100*10e-6 + 1000*1e-6 + 50*20e-6 = 0.003
    expect(record.totalCost?.currency).toBe('USD')
    expect(record.totalCost?.amount).toBeCloseTo(0.007, 10)

    const runDir = join(dir, 'results', record.runId)
    const stderr = await readFile(join(runDir, 'agent.stderr.log'), 'utf8')
    expect(stderr).toContain('--profile headless --patch /p.yml --json -')
    expect(stderr).toContain('env: DSH_TELEMETRY_MODE=DISABLED LAB_CLAUDE_EXECUTABLE=/opt/claude')
    expect(record.environment.hostTools.codexBundled).toBe('0.0.1')
    expect(await readFile(join(runDir, 'events.ndjson'), 'utf8')).toContain('"final"')

    const runs = await readRuns(join(dir, 'results'))
    expect(runs).toEqual([record])
    expect(toMarkdown(runs)).toContain('| 20261110T080000Z-t-x-c-x | t-x | c-x | 0 | 1/2 |')
    // 10+300+40+20 (Claude) + 400+600+70 (Codex)
    expect(toMarkdown(runs)).toContain('| 1440 |')
    expect(toCsv(runs).split('\n')[1]).toContain('0.007000 USD')
  })
})
