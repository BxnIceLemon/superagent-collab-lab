import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { checkoutDir, type BenchmarkRef, type BenchmarkSource } from './benchmarks.ts'

/**
 * Benchmark scoring: each benchmark's own evaluation, run in its scorer image
 * (`benchmarks/scorers/<name>/`) with the pinned checkout mounted read-only.
 * The agent's workspace is mounted read-only too; the scorers work on copies.
 */

/** What a scorer writes to `score.json`. */
const ScorerOutput = z.object({
  metrics: z.record(z.string(), z.number()),
  judgeModel: z.string().optional(),
  testImage: z.object({ name: z.string(), repoDigests: z.array(z.string()) }).optional(),
  status: z.string().optional(),
  error: z.string().nullable().optional(),
}).loose()

export const BenchmarkScore = z.object({
  benchmark: z.string(),
  item: z.string(),
  level: z.number().int().nullable(),
  sourceCommit: z.string(),
  scorerImage: z.object({ tag: z.string(), id: z.string().nullable() }),
  /** ok: the evaluation ran; error: it could not run, and metrics are empty. */
  status: z.enum(['ok', 'error']),
  metrics: z.record(z.string(), z.number()),
  /** ProjectEval: the model its judge asks for test parameters. */
  judgeModel: z.string().nullable(),
  /** NL2Repo-Bench: the task's published test image. */
  testImage: z.object({ name: z.string(), repoDigests: z.array(z.string()) }).nullable(),
  error: z.string().nullable(),
  wallMs: z.number().int().nonnegative(),
})
export type BenchmarkScore = z.output<typeof BenchmarkScore>

/** The model ProjectEval's judge uses to read test parameters from a submission, for every condition. */
export const PROJECTEVAL_JUDGE_MODEL = 'deepseek-flash'

/**
 * The scorer image tag for a benchmark at its pinned commit.
 * @param source - the pinned source.
 * @returns the local image tag.
 */
export function scorerTag(source: Pick<BenchmarkSource, 'name' | 'commit'>): string {
  return `collab-lab-scorer-${source.name}:${source.commit.slice(0, 12)}`
}

function run(command: string, args: string[], log: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = createWriteStream(log)
    child.stdout.pipe(out)
    child.stderr.pipe(out)
    child.on('error', reject)
    child.on('close', code => { out.end(); resolve(code) })
  })
}

/**
 * Builds a benchmark's scorer image from `benchmarks/scorers/<name>/`.
 * ProjectEval's also gets the package list of the pinned checkout.
 * @param labDir - the lab directory.
 * @param source - the pinned source.
 * @param log - file receiving the build output.
 * @returns the image tag.
 */
export async function buildScorerImage(labDir: string, source: BenchmarkSource, log: string): Promise<string> {
  const tag = scorerTag(source)
  const context = join(labDir, '.cache/build', source.name)
  await rm(context, { recursive: true, force: true })
  await cp(join(labDir, 'benchmarks/scorers', source.name), context, { recursive: true })
  if (source.name === 'projecteval') await cp(join(checkoutDir(labDir, source), 'requirements-docker.txt'), join(context, 'requirements-docker.txt'))
  const code = await run('docker', ['build', '--tag', tag, context], log)
  if (code !== 0) throw new Error(`building ${tag} failed; see ${log}`)
  return tag
}

function imageId(tag: string): string | null {
  const result = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Scores a workspace on one benchmark item.
 * @param options - the lab directory, the pinned source, the item, the workspace and where to write.
 * @returns the score; a scorer that fails gives status `error` rather than throwing.
 */
export async function scoreWorkspace(options: {
  labDir: string
  source: BenchmarkSource
  ref: BenchmarkRef
  workspace: string
  outDir: string
}): Promise<BenchmarkScore> {
  const { labDir, source, ref, workspace, outDir } = options
  if (ref.commit !== source.commit) throw new Error(`the task was generated at ${ref.commit}, but ${source.name} is pinned at ${source.commit}`)
  await mkdir(outDir, { recursive: true })
  const tag = scorerTag(source)
  const args = [
    // --init: xvfb-run as process 1 never sees Xvfb's ready signal.
    'run', '--rm', '--init',
    '--shm-size', '2g',
    '--volume', `${checkoutDir(labDir, source)}:/bench:ro`,
    '--volume', `${workspace}:/workspace:ro`,
    '--volume', `${outDir}:/out`,
  ]
  const env = { ...process.env }
  if (source.name === 'projecteval') args.push('--env', 'DEEPSEEK_API_KEY')
  // The scorer starts the task's test container next to itself, on the same daemon.
  if (source.name === 'nl2repo') args.push('--volume', '/var/run/docker.sock:/var/run/docker.sock')
  args.push(tag, '--item', ref.item)
  if (source.name === 'projecteval') args.push('--level', String(ref.level ?? 1), '--judge-model', PROJECTEVAL_JUDGE_MODEL)

  const started = performance.now()
  const code = await run('docker', args, join(outDir, 'scorer.log'), env)
  const wallMs = Math.round(performance.now() - started)
  const base = {
    benchmark: source.name,
    item: ref.item,
    level: ref.level ?? null,
    sourceCommit: source.commit,
    scorerImage: { tag, id: imageId(tag) },
    wallMs,
  }
  let output: z.output<typeof ScorerOutput>
  try {
    output = ScorerOutput.parse(JSON.parse(await readFile(join(outDir, 'score.json'), 'utf8')))
  } catch {
    return { ...base, status: 'error', metrics: {}, judgeModel: null, testImage: null, error: `scorer exited with ${code}; see scorer.log` }
  }
  const failed = output.status !== undefined && output.status !== 'success'
  return {
    ...base,
    status: failed ? 'error' : 'ok',
    metrics: output.metrics,
    judgeModel: output.judgeModel ?? null,
    testImage: output.testImage ?? null,
    error: output.error ?? null,
  }
}
