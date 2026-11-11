import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SuperagentOptions } from '../src/experiment.ts'
import { runExperiment } from '../src/runner.ts'
import { stopReason, type Observation } from '../src/superagent.ts'

const fake = fileURLToPath(new URL('fixtures/fake-superagent.mjs', import.meta.url))
const limits = { quietMs: 30_000, noTicketMs: 600_000, timeoutMs: 3_600_000 }
const ticket = (stage: string) => ({ id: 't', stage })
const at = (s: number, open: Observation['open'], ended: Observation['ended'] = []): Observation => ({ at: s * 1000, open, ended })

describe('stopReason', () => {
  it('waits while a Ticket works, and settles once all ended and stayed so', () => {
    expect(stopReason([at(5, [ticket('working')])], limits)).toBeNull()
    expect(stopReason([at(5, [ticket('working')]), at(10, [], [ticket('ended')])], limits)).toBeNull()
    expect(stopReason([at(5, [ticket('working')]), at(10, [], [ticket('ended')]), at(40, [], [ticket('ended')])], limits)).toBe('settled')
  })

  it('stops for a person only once the wait held for the quiet period', () => {
    const asks = [at(5, [ticket('working')]), at(10, [ticket('person')]), at(30, [ticket('person')])]
    expect(stopReason(asks, limits)).toBeNull()
    expect(stopReason([...asks, at(41, [ticket('person')])], limits)).toBe('needs-person')
    // A Ticket still working keeps the run going.
    expect(stopReason([...asks, at(41, [ticket('person'), ticket('working')])], limits)).toBeNull()
  })

  it('gives up without a Ticket, and stops at the time limit', () => {
    expect(stopReason([at(300, [])], limits)).toBeNull()
    expect(stopReason([at(600, [])], limits)).toBe('no-ticket')
    expect(stopReason([at(3600, [ticket('working')])], limits)).toBe('timeout')
  })
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lab-superagent-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runExperiment with dsh-superagent', () => {
  it('sets the prototype up offline, posts the task and records the Tickets', async () => {
    const lab = join(dir, 'lab')
    await mkdir(join(lab, 'superagent/lib'), { recursive: true })
    await writeFile(join(lab, 'superagent/lib/index.js'), '')
    await mkdir(join(lab, 'superagent-lab/prompts'), { recursive: true })
    await writeFile(join(lab, 'superagent-lab/prompts/delivery.md'), 'Deliver in the directory.\n')

    const record = await runExperiment({
      repoRoot: dir,
      labDir: lab,
      resultsDir: join(dir, 'results'),
      task: {
        file: '/tasks/t.yaml',
        value: { version: 1, id: 't-x', title: 'x', prompt: 'build it', gates: [{ id: 'readme', run: 'test -s README.md', timeoutSec: 10 }] },
      },
      condition: {
        file: '/conditions/s.yaml',
        value: {
          version: 1,
          id: 's-x',
          description: 'x',
          launcher: 'dsh-superagent',
          patches: ['/p.yml'],
          env: {},
          superagent: SuperagentOptions.parse({ quietSec: 1, pollSec: 1 }),
        },
      },
      launcher: { command: process.execPath, args: [fake], env: {} },
      hostTools: { claudeCodeBundled: null, codexBundled: null, claudeCodeHost: null },
      now: () => new Date('2026-11-10T08:00:00.000Z'),
    })

    expect(record.agent.code).toBe(0)
    expect(record.gates.map(g => [g.id, g.passed])).toEqual([['readme', true]])
    expect(record.superagent).toEqual({
      stopReason: 'settled',
      tickets: [{ id: 't1', title: 'Make it', state: 'ended', stage: 'ended', action: null, outcome: 'completed', summary: 'Wrote README.md.' }],
      replies: 1,
    })
    expect(record.followUpMessages).toBe(0)
    expect(record.usage).toEqual([expect.objectContaining({ provider: 'p', model: 'cheap', calls: 1, inputTokens: 1000, source: 'dsh-session' })])

    const runDir = join(dir, 'results', record.runId)
    const requests = (await readFile(join(runDir, 'dsh-home/fake-requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { args?: string[]; method?: string; path?: string; body?: Record<string, unknown>; header?: string })
    expect(requests[0]!.args).toEqual(['superagent', '--from-default-profile', 'web', '--dump-config'])
    expect(requests[1]!.args).toEqual(['plugin', '--profile', 'superagent', 'add', `link:${join(lab, 'superagent')}`, `link:${join(lab, 'superagent-lab')}`])
    expect(requests[2]!.args!.slice(0, 3)).toEqual(['superagent', '--patch', '/p.yml'])
    const saves = requests.filter(r => r.method === 'PUT')
    expect(saves.map(r => r.path)).toEqual(['settings/source:github', 'settings/policy', 'settings/executor', 'prompts', 'settings/source:lab-task'])
    expect(saves.every(r => r.header === '1')).toBe(true)
    expect(saves[0]!.body).toMatchObject({ value: { enabled: false, config: { repository: 'lab/workspace', cli: join(lab, 'superagent-lab/bin/gh-offline') } } })
    expect(saves[1]!.body).toMatchObject({ value: { sources: { 'lab-task': { allowed: [{ id: 'operator' }] } } } })
    expect(saves[3]!.body).toMatchObject({ config: { communication: 'c', delivery: 'Deliver in the directory.\n' }, baseRevision: 0 })

    const inbox = JSON.parse(await readFile(join(runDir, 'inbox.jsonl'), 'utf8')) as Record<string, unknown>
    expect(inbox).toMatchObject({ id: 'task', from: 'operator', text: 'build it' })
    const profile = await readFile(join(runDir, 'dsh-home/profiles/superagent/cordis.patch.yml'), 'utf8')
    expect(profile).toContain(`stateDir: ${JSON.stringify(join(runDir, 'superagent'))}`)
    expect(profile).toContain('name: collab-lab-superagent-source')
  })
})
