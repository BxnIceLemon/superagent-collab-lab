/**
 * The `lab-task` Source: a lab run's operator talks to dsh-superagent through
 * two local JSON Lines files instead of GitHub or Feishu.
 *
 * - The inbox holds the operator's messages, `{"id", "from", "text", "at"}`,
 *   written by the lab harness. Each becomes a Trigger addressed to the agent
 *   on one Thread, `lab-task:task`.
 * - The outbox receives the agent's acknowledgements, replies and notices,
 *   one line per message id.
 *
 * The prototype is unchanged: this package only uses its Source interface
 * (lab/superagent/docs/008-cookbook.md).
 */
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { ContextMessage, OutboundMessage, PluginContext, SourceContext, SourceKind, Trigger } from './host.ts'

export const KIND = 'lab-task'
/** The one Thread of a lab run. */
export const THREAD = 'task'

const Config = z.object({
  /** Absolute path of the operator's messages; empty receives nothing. */
  inbox: z.string().default(''),
  /** Absolute path the agent's messages are appended to. */
  outbox: z.string().default(''),
  pollSeconds: z.number().int().min(1).max(60).default(2),
}).strict()
export type LabTaskConfig = z.infer<typeof Config>

const InboxMessage = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  text: z.string(),
  at: z.iso.datetime(),
})
export type InboxMessage = z.infer<typeof InboxMessage>

const OutboxLine = z.object({ id: z.string(), text: z.string(), at: z.string() }).loose()

/** Stable id, as dsh-superagent's own `key` derives it. */
function key(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}

async function lines(path: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
}

/** Every operator message is addressed to the agent: the inbox is a direct conversation. */
export function labTrigger(message: InboxMessage, config: LabTaskConfig): Trigger {
  return {
    id: key(KIND, message.id),
    source: KIND,
    threads: [{ source: KIND, id: THREAD }],
    actor: { source: KIND, id: message.from },
    human: true,
    addressed: 'direct',
    at: message.at,
    text: message.text,
    channel: { source: KIND, thread: `${KIND}:${THREAD}`, address: { outbox: config.outbox, message: message.id } },
    meta: { messageId: message.id, inbox: config.inbox, outbox: config.outbox },
  }
}

/** Appends a message to the outbox once per id, so a retried send does not repeat it. */
export async function sendLabTask(message: OutboundMessage): Promise<'sent'> {
  const outbox = message.channel.address.outbox
  if (!outbox) throw new Error('lab-task reply has no outbox')
  const sent = (await lines(outbox)).some(line => OutboxLine.safeParse(line).data?.id === message.id)
  if (!sent) {
    const line = { id: message.id, kind: message.kind, ticketId: message.ticketId ?? null, text: message.text, at: new Date().toISOString() }
    await appendFile(outbox, `${JSON.stringify(line)}\n`)
  }
  return 'sent'
}

/** The conversation so far: operator messages and the agent's replies, oldest first. */
export async function conversation(trigger: Trigger): Promise<ContextMessage[]> {
  const inbox = (await lines(String(trigger.meta.inbox ?? ''))).flatMap(line => {
    const message = InboxMessage.safeParse(line)
    return message.success ? [{ id: message.data.id, from: message.data.from, at: message.data.at, text: message.data.text }] : []
  })
  const outbox = (await lines(String(trigger.meta.outbox ?? ''))).flatMap(line => {
    const message = OutboxLine.safeParse(line)
    return message.success ? [{ id: message.data.id, from: 'agent', at: message.data.at, text: message.data.text, bot: true as const }] : []
  })
  return [...inbox, ...outbox].sort((a, b) => a.at.localeCompare(b.at))
}

export const labTaskKind: SourceKind<LabTaskConfig> = {
  kind: KIND,
  title: { zh: '实验任务', en: 'Lab task' },
  description: { zh: '从本地收件文件接收实验任务，把回复写入发件文件。', en: 'Takes a lab task from a local inbox file and writes replies to an outbox file.' },
  schema: Config,
  fields: [
    { key: 'inbox', type: 'text', label: { zh: '收件文件', en: 'Inbox file' } },
    { key: 'outbox', type: 'text', label: { zh: '发件文件', en: 'Outbox file' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 60, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: [KIND],
  channel: {
    send: (_host, message) => sendLabTask(message),
    link: () => ({ url: '', label: { zh: '实验任务对话', en: 'Lab task conversation' } }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    read: async (_commands, trigger) => {
      const messages = await conversation(trigger)
      return { messages, body: { messages } }
    },
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{
      key: 'allowed',
      type: 'rows',
      label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ],
    }],
    explicit: { zh: '收件文件里的每条消息都直接发给智能体。', en: 'Every inbox message is addressed to the agent.' },
  },
}

/** Takes in every inbox message; the Engine stores each id once, so rereading the file is safe. */
export async function pollInbox(ctx: SourceContext, config: LabTaskConfig): Promise<{ read: number; unreadable: number }> {
  let unreadable = 0
  const items = await lines(config.inbox)
  for (const item of items) {
    const message = InboxMessage.safeParse(item)
    if (!message.success) { unreadable++; continue }
    await ctx.receive(labTrigger(message.data, config))
  }
  return { read: items.length, unreadable }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    ctx.report(KIND, { state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' })
    return
  }
  while (!signal.aborted) {
    const config = ctx.config<LabTaskConfig>(KIND)
    if (config === undefined || config.inbox === '') {
      ctx.report(KIND, { state: 'paused', detail: 'Off', code: 'sourceOff' })
    } else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollInbox(ctx, config)
        ctx.report(KIND, { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        ctx.report(KIND, { state: 'error', detail: String(error), at })
      }
    }
    await delay((config?.pollSeconds ?? 2) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'collab-lab-superagent-source'
export const inject = ['orchestrator']
export function apply(ctx: PluginContext): void {
  ctx.effect(() => ctx.orchestrator.sources.register(labTaskKind), 'lab-task: source kind')
  ctx.effect(() => {
    const source = ctx.orchestrator.context(labTaskKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(KIND, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
