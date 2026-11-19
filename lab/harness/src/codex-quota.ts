import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/**
 * Keeps Codex workers from stalling on the weekly limit. While a run that can
 * delegate to Codex is going, the harness checks the Codex account's weekly
 * window; when less than the threshold is left and a banked reset card is
 * available, it spends one card. Everything happens in the harness, outside
 * the agent: nothing reaches any session's context, and the record keeps only
 * percentages, times and result codes (no token, email or account id).
 *
 * The endpoints are ChatGPT's own usage API, which the Codex app reads; the
 * same calls are made by the operator's boring.notch fork
 * (BoringNotchXPCHelper/Accounts/CodexAccounts.swift):
 * - GET  /backend-api/wham/usage: `rate_limit` windows and `rate_limit_reset_credits`.
 * - GET  /backend-api/wham/rate-limit-reset-credits: the cards, with id, status and expiry.
 * - POST /backend-api/wham/rate-limit-reset-credits/consume: spends one card.
 *
 * Rules, as boring.notch keeps them: the login is read, never refreshed or
 * written (the Codex CLI owns it); a card is spent at most once per run and
 * the request is never retried.
 */

const BASE = 'https://chatgpt.com/backend-api'
const WEEK_SECONDS = 7 * 24 * 3600
const WEEK_MINUTES = 7 * 24 * 60

export const QuotaCheck = z.object({
  at: z.string(),
  /** ok, or why no figure: no_login, token_expired, http_<status>, network, no_weekly_window. */
  status: z.string(),
  /** Percent of the weekly window left, 0 to 100. */
  weeklyRemaining: z.number().nullable(),
  weeklyResetsAt: z.string().nullable(),
  cardsAvailable: z.number().int().nullable(),
})
export type QuotaCheck = z.output<typeof QuotaCheck>

export const QuotaReset = z.object({
  at: z.string(),
  /** Remaining percent that triggered it. */
  weeklyRemaining: z.number(),
  /** The server's result code, or no_card / unknown. */
  code: z.string(),
  cardExpiresAt: z.string().nullable(),
})
export type QuotaReset = z.output<typeof QuotaReset>

export const CodexQuotaRecord = z.object({
  plan: z.string().nullable(),
  thresholdPercent: z.number(),
  checks: z.array(QuotaCheck),
  resets: z.array(QuotaReset),
})
export type CodexQuotaRecord = z.output<typeof CodexQuotaRecord>

type Json = Record<string, unknown>
type Fetch = typeof fetch

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The Codex login the run's Codex workers use: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
}

function claims(jwt: unknown): Json {
  if (typeof jwt !== 'string') return {}
  try {
    const body = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as unknown
    return isObject(body) ? body : {}
  } catch {
    return {}
  }
}

interface Login { headers: Record<string, string>; plan: string | null }

async function readLogin(path: string): Promise<Login | null> {
  let auth: unknown
  try {
    auth = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
  const tokens = isObject(auth) && isObject(auth.tokens) ? auth.tokens : null
  if (tokens === null || typeof tokens.access_token !== 'string') return null
  const authClaims = claims(tokens.id_token)['https://api.openai.com/auth']
  const accountClaims = isObject(authClaims) ? authClaims : {}
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id : accountClaims.chatgpt_account_id
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    'User-Agent': 'collab-lab',
    Accept: 'application/json',
  }
  if (typeof accountId === 'string') headers['ChatGPT-Account-ID'] = accountId
  if (accountClaims.chatgpt_account_is_fedramp === true) headers['X-OpenAI-Fedramp'] = 'true'
  const plan = typeof accountClaims.chatgpt_plan_type === 'string' ? accountClaims.chatgpt_plan_type : null
  return { headers, plan }
}

/** A window is weekly by its length, not its position: newer plans return the weekly one as primary. */
function isWeekly(window: Json): boolean {
  const seconds = num(window.limit_window_seconds) ?? num(window.window_seconds)
  if (seconds !== null) return seconds === WEEK_SECONDS
  const minutes = num(window.window_duration_mins)
  return minutes === WEEK_MINUTES
}

async function getJson(f: Fetch, login: Login, path: string, beta = false): Promise<{ status: string; json: Json | null }> {
  try {
    const response = await f(`${BASE}${path}`, { headers: { ...login.headers, ...(beta ? { 'OpenAI-Beta': 'codex-1' } : {}) } })
    if (response.status === 401) return { status: 'token_expired', json: null }
    if (response.status !== 200) return { status: `http_${response.status}`, json: null }
    const json = (await response.json()) as unknown
    return { status: 'ok', json: isObject(json) ? json : null }
  } catch {
    return { status: 'network', json: null }
  }
}

/** Available cards that the plan supports, earliest expiry first. */
function cards(payload: Json): { id: string; expiresAt: string | null }[] {
  const list = Array.isArray(payload.credits) ? payload.credits : []
  return list
    .filter((c): c is Json => isObject(c) && c.status === 'available' && typeof c.id === 'string' && c.is_supported_by_plan !== false)
    .map(c => ({ id: c.id as string, expiresAt: typeof c.expires_at === 'string' ? c.expires_at : null }))
    .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999'))
}

export interface CodexQuotaGuardOptions {
  /** Spend a card when the weekly window has less than this percent left. */
  thresholdPercent?: number
  /** Minutes between checks while the run goes on. */
  intervalMinutes?: number
  authPath?: string
  fetch?: Fetch
  now?: () => Date
}

/** Watches the weekly window during one run; {@link stop} returns what it saw and did. */
export class CodexQuotaGuard {
  private readonly threshold: number
  private readonly intervalMs: number
  private readonly authPath: string
  private readonly fetch: Fetch
  private readonly now: () => Date
  private readonly checks: QuotaCheck[] = []
  private readonly resets: QuotaReset[] = []
  private plan: string | null = null
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> = Promise.resolve()

  constructor(options: CodexQuotaGuardOptions = {}) {
    this.threshold = options.thresholdPercent ?? 5
    this.intervalMs = (options.intervalMinutes ?? 10) * 60_000
    this.authPath = options.authPath ?? codexAuthPath()
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  /** Checks once now, then every interval until {@link stop}. */
  async start(): Promise<void> {
    await this.check()
    this.timer = setInterval(() => { this.running = this.running.then(() => this.check()) }, this.intervalMs)
    this.timer.unref()
  }

  /** Stops checking, after one final check that only reads, and returns the record. */
  async stop(): Promise<CodexQuotaRecord> {
    clearInterval(this.timer)
    await this.running
    await this.check(false)
    return { plan: this.plan, thresholdPercent: this.threshold, checks: this.checks, resets: this.resets }
  }

  /**
   * One check, and a reset when the weekly window is under the threshold.
   * @param mayReset - false for a reading only, as after the run.
   */
  async check(mayReset = true): Promise<void> {
    const at = this.now().toISOString()
    const blank = { at, weeklyRemaining: null, weeklyResetsAt: null, cardsAvailable: null }
    const login = await readLogin(this.authPath)
    if (login === null) {
      this.checks.push({ ...blank, status: 'no_login' })
      return
    }
    this.plan = login.plan ?? this.plan
    const usage = await getJson(this.fetch, login, '/wham/usage')
    if (usage.json === null) {
      this.checks.push({ ...blank, status: usage.status === 'ok' ? 'bad_response' : usage.status })
      return
    }
    if (typeof usage.json.plan_type === 'string') this.plan = usage.json.plan_type
    const rate = isObject(usage.json.rate_limit) ? usage.json.rate_limit : {}
    const weekly = [rate.primary_window, rate.secondary_window].find((w): w is Json => isObject(w) && isWeekly(w))
    const credits = isObject(usage.json.rate_limit_reset_credits) ? usage.json.rate_limit_reset_credits : {}
    const cardsAvailable = num(credits.available_count)
    const used = weekly === undefined ? null : num(weekly.used_percent)
    const resetAt = weekly === undefined ? null : num(weekly.reset_at)
    const remaining = used === null ? null : Math.max(0, 100 - used)
    this.checks.push({
      at,
      status: remaining === null ? 'no_weekly_window' : 'ok',
      weeklyRemaining: remaining,
      weeklyResetsAt: resetAt === null ? null : new Date(resetAt * 1000).toISOString(),
      cardsAvailable,
    })
    // One card per run at most: a second low reading after a reset is left alone.
    if (!mayReset || remaining === null || remaining >= this.threshold || this.resets.length > 0 || (cardsAvailable ?? 0) <= 0) return
    this.resets.push({ at, weeklyRemaining: remaining, ...(await this.redeem(login)) })
  }

  /** Spends the earliest-expiring card. Never retried. */
  private async redeem(login: Login): Promise<{ code: string; cardExpiresAt: string | null }> {
    const list = await getJson(this.fetch, login, '/wham/rate-limit-reset-credits', true)
    const card = list.json === null ? undefined : cards(list.json)[0]
    if (card === undefined) return { code: list.json === null ? list.status : 'no_card', cardExpiresAt: null }
    try {
      const response = await this.fetch(`${BASE}/wham/rate-limit-reset-credits/consume`, {
        method: 'POST',
        headers: { ...login.headers, 'OpenAI-Beta': 'codex-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ redeem_request_id: randomUUID(), credit_id: card.id }),
      })
      const json = (await response.json().catch(() => null)) as unknown
      const code = isObject(json) && typeof json.code === 'string' ? json.code : `http_${response.status}`
      return { code, cardExpiresAt: card.expiresAt }
    } catch {
      return { code: 'unknown', cardExpiresAt: card.expiresAt }
    }
  }
}

/**
 * Whether a condition can delegate to Codex, judged by its patches.
 * @param patches - the condition's patch paths.
 * @returns true when one of them adds Codex workers.
 */
export function usesCodexWorkers(patches: readonly string[]): boolean {
  return patches.some(p => /worker-codex\.ya?ml$/.test(p))
}
