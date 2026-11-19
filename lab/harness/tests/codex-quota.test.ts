import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexQuotaGuard, usesCodexWorkers } from '../src/codex-quota.ts'

const jwt = (body: object): string => `x.${Buffer.from(JSON.stringify(body)).toString('base64url')}.y`

async function login(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'codex-')), 'auth.json')
  await writeFile(path, JSON.stringify({ tokens: {
    access_token: 'secret-token',
    account_id: 'acct-1',
    id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
  } }))
  return path
}

interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }

/** A fake ChatGPT usage API: weekly used percent per successive usage call, and three cards. */
function api(usedPercents: number[], consumeCode = 'success') {
  const calls: Call[] = []
  let n = 0
  const f = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace('/backend-api', '')
    calls.push({ method: init.method ?? 'GET', path, headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(init.body as string) })
    const json = (body: object) => new Response(JSON.stringify(body), { status: 200 })
    if (path === '/wham/usage') {
      const used = usedPercents[Math.min(n++, usedPercents.length - 1)]
      return json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 1795105954 }, secondary_window: null }, rate_limit_reset_credits: { available_count: 3 } })
    }
    if (path === '/wham/rate-limit-reset-credits') {
      return json({ credits: [
        { id: 'late', status: 'available', expires_at: '2026-12-12T00:00:00Z' },
        { id: 'used', status: 'redeemed', expires_at: '2026-11-20T00:00:00Z' },
        { id: 'early', status: 'available', expires_at: '2026-11-30T00:00:00Z' },
        { id: 'other-plan', status: 'available', is_supported_by_plan: false, expires_at: '2026-11-21T00:00:00Z' },
      ] })
    }
    if (path === '/wham/rate-limit-reset-credits/consume') return json({ code: consumeCode })
    return new Response('', { status: 404 })
  }) as typeof fetch
  return { f, calls }
}

const now = () => new Date('2026-11-19T00:00:00Z')

describe('Codex weekly-limit guard', () => {
  it('reads the weekly window and leaves cards alone above the threshold', async () => {
    const { f, calls } = api([16])
    const guard = new CodexQuotaGuard({ authPath: await login(), fetch: f, now })
    await guard.check()
    const record = await guard.stop()
    expect(record.plan).toBe('plus')
    expect(record.checks[0]).toEqual({ at: '2026-11-19T00:00:00.000Z', status: 'ok', weeklyRemaining: 84, weeklyResetsAt: '2026-11-19T16:32:34.000Z', cardsAvailable: 3 })
    expect(record.resets).toEqual([])
    expect(calls.every(c => c.path === '/wham/usage')).toBe(true)
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer secret-token', 'ChatGPT-Account-ID': 'acct-1' })
  })

  it('spends the earliest-expiring supported card once when under 5% is left', async () => {
    const { f, calls } = api([96, 97, 98])
    const guard = new CodexQuotaGuard({ authPath: await login(), fetch: f, now })
    await guard.check()
    await guard.check()
    const record = await guard.stop()
    expect(record.resets).toEqual([{ at: '2026-11-19T00:00:00.000Z', weeklyRemaining: 4, code: 'success', cardExpiresAt: '2026-11-30T00:00:00Z' }])
    const consumes = calls.filter(c => c.path.endsWith('/consume'))
    expect(consumes).toHaveLength(1)
    expect(consumes[0]!.body).toMatchObject({ credit_id: 'early' })
    expect(consumes[0]!.headers['OpenAI-Beta']).toBe('codex-1')
  })

  it('records a refused reset without retrying it', async () => {
    const { f, calls } = api([99], 'not_applicable')
    const guard = new CodexQuotaGuard({ authPath: await login(), fetch: f, now })
    await guard.check()
    await guard.check()
    expect((await guard.stop()).resets.map(r => r.code)).toEqual(['not_applicable'])
    expect(calls.filter(c => c.path.endsWith('/consume'))).toHaveLength(1)
  })

  it('never resets on the reading after the run', async () => {
    const { f, calls } = api([99])
    const guard = new CodexQuotaGuard({ authPath: await login(), fetch: f, now })
    expect((await guard.stop()).resets).toEqual([])
    expect(calls.some(c => c.path.endsWith('/consume'))).toBe(false)
  })

  it('notes a missing login or an expired token instead of failing the run', async () => {
    const missing = new CodexQuotaGuard({ authPath: '/nonexistent/auth.json', now })
    expect((await missing.stop()).checks[0]!.status).toBe('no_login')
    const expired = new CodexQuotaGuard({ authPath: await login(), fetch: (async () => new Response('', { status: 401 })) as typeof fetch, now })
    expect((await expired.stop()).checks[0]!.status).toBe('token_expired')
  })

  it('keeps no secret in its record', async () => {
    const { f } = api([96])
    const guard = new CodexQuotaGuard({ authPath: await login(), fetch: f, now })
    await guard.check()
    const text = JSON.stringify(await guard.stop())
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('acct-1')
  })

  it('runs only for conditions with Codex workers', () => {
    expect(usesCodexWorkers(['/x/patches/plain-session-log.yml', '/x/patches/worker-codex.yml'])).toBe(true)
    expect(usesCodexWorkers(['/x/patches/worker-claude-code.yml'])).toBe(false)
  })
})
