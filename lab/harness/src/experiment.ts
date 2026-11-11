import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { readDocument } from './files.ts'

/** Experiment inputs: a task to attempt and a condition to attempt it under. */

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits or "-"')

/** A shell command run in the task workspace after the agent finishes. */
export const Gate = z.object({
  id: Id,
  run: z.string().min(1),
  timeoutSec: z.number().int().positive().default(600),
})
export type Gate = z.output<typeof Gate>

export const LabTask = z.object({
  version: z.literal(1),
  id: Id,
  title: z.string().min(1),
  /** The exact text given to the agent. */
  prompt: z.string().min(1),
  /** Directory copied into the workspace before the run, relative to the task file. */
  fixture: z.string().min(1).optional(),
  gates: z.array(Gate).default([]),
})
export type LabTask = z.output<typeof LabTask>

/** When a dsh-superagent run is over; see `stopReason` in superagent.ts. */
export const SuperagentOptions = z.object({
  /** Seconds with nothing in progress before the run counts as over. */
  quietSec: z.number().int().positive().default(60),
  /** Minutes to wait for the first Ticket. */
  noTicketMin: z.number().int().positive().default(10),
  /** Minutes before the run is stopped regardless. */
  timeoutMin: z.number().int().positive().default(120),
  /** Seconds between two reads of the Tickets. */
  pollSec: z.number().int().positive().default(5),
}).strict()
export type SuperagentOptions = z.output<typeof SuperagentOptions>

const ConditionBase = {
  version: z.literal(1),
  id: Id,
  description: z.string().min(1),
  /** DSH loader patch files applied in order, relative to the condition file. */
  patches: z.array(z.string().min(1)).default([]),
  /** Extra non-secret environment variables. Credentials come from the caller's environment. */
  env: z.record(z.string(), z.string()).default({}),
}

export const Condition = z.discriminatedUnion('launcher', [
  /** One-shot `dsh --profile headless`, the prompt on standard input. */
  z.object({ ...ConditionBase, launcher: z.literal('dsh-headless') }),
  /** The dsh-superagent prototype on its own Web profile; the prompt arrives through the lab-task Source. */
  z.object({ ...ConditionBase, launcher: z.literal('dsh-superagent'), superagent: SuperagentOptions.default(SuperagentOptions.parse({})) }),
])
export type Condition = z.output<typeof Condition>

export interface Loaded<T> {
  /** Absolute path of the file it was read from. */
  file: string
  value: T
}

/**
 * Loads a task file and resolves its fixture path.
 * @param file - path of the task YAML.
 * @returns the task with an absolute fixture path.
 */
export async function loadTask(file: string): Promise<Loaded<LabTask>> {
  const abs = resolve(file)
  const value = await readDocument(abs, LabTask)
  if (value.fixture !== undefined) value.fixture = resolve(dirname(abs), value.fixture)
  return { file: abs, value }
}

/**
 * Loads a condition file and resolves its patch paths.
 * @param file - path of the condition YAML.
 * @returns the condition with absolute patch paths.
 */
export async function loadCondition(file: string): Promise<Loaded<Condition>> {
  const abs = resolve(file)
  const value = await readDocument(abs, Condition)
  value.patches = value.patches.map(p => resolve(dirname(abs), p))
  return { file: abs, value }
}
