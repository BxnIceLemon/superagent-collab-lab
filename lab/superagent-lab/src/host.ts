/**
 * The parts of dsh-superagent's Source interface this package uses, restated
 * from lab/superagent/src/sources/{host,kind}.ts and src/core so the package
 * needs no build of the prototype to typecheck. Only types live here.
 */
import type { z } from 'zod'

export interface Localized { zh: string; en: string }
export interface ThreadRef { source: string; id: string }
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

export interface Trigger {
  id: string
  source: string
  threads: ThreadRef[]
  actor: { source: string; id: string }
  human: boolean
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  meta: Record<string, unknown>
}

export interface OutboundMessage {
  id: string
  channel: ChannelRef
  text: string
  kind: 'acknowledgement' | 'reply' | 'notice'
  ticketId?: string
}

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

export interface Health {
  state: 'starting' | 'ready' | 'paused' | 'error'
  detail: string
  at?: string
  code?: 'setupPending' | 'sourceOff'
}

export interface SourceContext {
  readonly ready: Promise<void>
  configured(): boolean
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  report(entry: string, health: Health): void
}

export interface ContextMessage { id: string; from: string; at: string; text: string; bot?: true }
export interface ContextPart { messages: ContextMessage[]; next?: string; body: Record<string, unknown> }

type Field =
  | { key: string; label: Localized; type: 'text' }
  | { key: string; label: Localized; type: 'number'; min: number; max: number; advanced?: true }
  | { key: string; label: Localized; type: 'rows'; columns: { key: string; label: Localized; type: 'text'; optional?: boolean }[] }

export interface SourceKind<C extends Record<string, unknown>> {
  kind: string
  title: Localized
  description: Localized
  schema: z.ZodType<C>
  fields: Field[]
  health: string[]
  channel: {
    send(host: unknown, message: OutboundMessage): Promise<'sent' | 'gone'>
    link(address: Record<string, string>): { url: string; label: Localized }
  }
  threadContext: {
    messageId(trigger: Trigger): string
    read(commands: unknown, trigger: Trigger): Promise<ContextPart>
  }
  policy: {
    schema: z.ZodType<{ allowed: { id: string; name?: string | undefined }[] }>
    fields: Field[]
    explicit: Localized
  }
}

export interface SourceHost {
  readonly sources: { register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void }
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}

/** The Cordis context of a plugin that injects `orchestrator`. */
export interface PluginContext {
  readonly orchestrator: SourceHost
  effect(execute: () => (() => unknown) | void, label?: string): void
}
