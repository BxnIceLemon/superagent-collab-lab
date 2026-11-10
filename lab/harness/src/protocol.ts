import { z } from 'zod'

/**
 * The two documents the supervisor and the collaborators exchange. The
 * supervisor never reads a collaborator's working history, only these.
 */

const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"')

export const Priority = z.enum(['P0', 'P1', 'P2'])

/** Supervisor to collaborator Router: one unit of work. */
export const TaskSheet = z.object({
  version: z.literal(1),
  id: Id,
  phase: z.string().min(1),
  goal: z.string().min(1),
  priority: Priority,
  taskType: z.string().min(1),
  difficulty: z.number().int().min(1).max(5),
  contractVersion: z.string().min(1),
  constraints: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  budget: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxCost: z.number().positive().optional(),
    })
    .default({}),
  related: z
    .array(z.object({ taskId: Id, model: z.string().min(1).optional() }))
    .default([]),
})
export type TaskSheet = z.output<typeof TaskSheet>

/** Collaborator Router to supervisor: the result of one task sheet. */
export const Ticket = z.object({
  version: z.literal(1),
  taskId: Id,
  status: z.enum(['completed', 'partial', 'failed']),
  changes: z.array(z.object({ path: z.string().min(1), summary: z.string().min(1) })).default([]),
  gateEvidence: z
    .array(z.object({ gate: z.string().min(1), passed: z.boolean(), detail: z.string().optional() }))
    .default([]),
  selfFixedIssues: z.array(z.string().min(1)).default([]),
  openIssues: z.array(z.string().min(1)).default([]),
  contractProposals: z.array(z.string().min(1)).default([]),
  rework: z
    .object({ used: z.number().int().nonnegative(), limit: z.number().int().nonnegative() })
    .refine(r => r.used <= r.limit, 'rework.used exceeds rework.limit'),
  cost: z
    .array(
      z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
    )
    .default([]),
})
export type Ticket = z.output<typeof Ticket>
