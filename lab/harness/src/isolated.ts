import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { BenchmarkSources } from './benchmarks.ts'
import { loadTask } from './experiment.ts'
import { readDocument } from './files.ts'
import { blockedPhrases, startNetwork } from './network.ts'
import { RunRecord } from './record.ts'
import type { Scorer } from './runner.ts'

/**
 * Isolated runs: the agent runs in a fresh container built from one commit
 * of this repository (`lab/isolation/Dockerfile`), and its workspace is
 * scored afterwards outside that container.
 *
 * The container sees only the run's inputs and its results directory. It has
 * no access to the operator's home directory, so no Claude Code or Codex
 * settings, skills, plugins or instructions reach the agent. Credentials are
 * passed per run: the DeepSeek key and a Claude Code token by environment
 * variable name (their values never appear in arguments or records), the
 * Codex login through its own volume. Its network goes through the lab
 * proxy, which refuses the task's original sources (see network.ts).
 */

/** The volume holding the Codex login used by isolated runs; separate from the operator's ~/.codex. */
export const CODEX_VOLUME = 'collab-lab-codex'
/** Where the repository sits inside the agent image. */
export const IMAGE_REPO = '/opt/lab-repo'
const IMAGE_RESULTS = '/lab-results'
/** Credentials passed through by name when set. */
const CREDENTIALS = ['DEEPSEEK_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/**
 * The agent image for a commit.
 * @param commit - full commit hash.
 * @returns the local image tag.
 */
export function agentImageTag(commit: string): string {
  return `collab-lab-agent:${commit.slice(0, 12)}`
}

function imageId(tag: string): string | null {
  const result = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Builds the agent image from the committed state of HEAD.
 * @param repoRoot - the repository root.
 * @param log - file receiving the build output.
 * @returns the tag, the commit, and whether the working tree had changes left out.
 */
export async function buildAgentImage(repoRoot: string, log: string): Promise<{ tag: string; commit: string; uncommitted: boolean }> {
  const commit = git(['rev-parse', 'HEAD'], repoRoot)
  const uncommitted = git(['status', '--porcelain'], repoRoot) !== ''
  const tag = agentImageTag(commit)
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(log)
    const archive = spawn('git', ['archive', '--format=tar', commit], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    const build = spawn('docker', ['build', '--file', 'lab/isolation/Dockerfile', '--build-arg', `LAB_REPO_COMMIT=${commit}`, '--tag', tag, '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    archive.stdout.pipe(build.stdin)
    // Three writers share the log, which closes only when the build exits.
    archive.stderr.pipe(out, { end: false })
    build.stdout.pipe(out, { end: false })
    build.stderr.pipe(out, { end: false })
    build.on('error', reject)
    build.on('close', code => {
      out.end()
      if (code === 0) resolve()
      else reject(new Error(`building ${tag} failed; see ${log}`))
    })
  })
  return { tag, commit, uncommitted }
}

/** Maps a lab file to its path in the image; it must be committed or under `.cache/tasks/`, which is mounted. */
function imagePath(repoRoot: string, labDir: string, file: string): string {
  const rel = relative(labDir, file)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${file} is outside ${labDir}; an isolated run can only use lab files`)
  if (!rel.startsWith(join('.cache', 'tasks'))) {
    const changed = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', file], { cwd: repoRoot }).status !== 0
    const untracked = git(['ls-files', '--others', '--exclude-standard', '--', file], repoRoot) !== ''
    if (changed || untracked) throw new Error(`${file} differs from HEAD; commit it so the image has it`)
  }
  return join(IMAGE_REPO, 'lab', rel)
}

export interface IsolatedRunOptions {
  repoRoot: string
  labDir: string
  resultsDir: string
  taskFile: string
  conditionFile: string
  /** Scores a benchmark task's workspace after the container exits. */
  scorer?: Scorer
  /** Memory limit of the agent container. */
  memory?: string
}

/**
 * Runs one task under one condition in a fresh agent container.
 * @param options - what to run and where to write it.
 * @returns the host path of the run's `run.json`.
 */
export async function runIsolated(options: IsolatedRunOptions): Promise<string> {
  const { repoRoot, labDir, resultsDir } = options
  const commit = git(['rev-parse', 'HEAD'], repoRoot)
  const tag = agentImageTag(commit)
  const id = imageId(tag)
  if (id === null) throw new Error(`no agent image for ${commit.slice(0, 12)}; run \`lab isolation build\` first`)

  const task = (await loadTask(options.taskFile)).value
  const sources = (await readDocument(join(labDir, 'benchmarks/sources.yaml'), BenchmarkSources)).benchmarks
  const network = await startNetwork(labDir, tag, blockedPhrases(sources, task.benchmark))

  const args = [
    'run', '--rm', '--init',
    ...network.agentArgs,
    '--memory', options.memory ?? '6g',
    '--shm-size', '1g',
    '--volume', `${resultsDir}:${IMAGE_RESULTS}`,
    '--volume', `${join(labDir, '.cache/tasks')}:${join(IMAGE_REPO, 'lab/.cache/tasks')}:ro`,
    '--volume', `${CODEX_VOLUME}:/home/node/.codex`,
  ]
  for (const name of CREDENTIALS) if (process.env[name]) args.push('--env', name)
  args.push(
    tag, 'run',
    '--task', imagePath(repoRoot, labDir, options.taskFile),
    '--condition', imagePath(repoRoot, labDir, options.conditionFile),
    '--results', IMAGE_RESULTS,
    '--no-score',
  )

  let runJson: string
  try {
    runJson = await new Promise<string>((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'inherit'] })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.on('error', reject)
      child.on('close', () => {
        const last = stdout.trim().split('\n').at(-1) ?? ''
        if (!last.startsWith(`${IMAGE_RESULTS}/`)) reject(new Error(`the agent container did not report a run: ${stdout.trim()}`))
        else resolve(join(resultsDir, relative(IMAGE_RESULTS, last)))
      })
    })
  } catch (error) {
    await network.close(null)
    throw error
  }

  const runDir = join(runJson, '..')
  const networkRecord = await network.close(runDir)
  const record = RunRecord.parse(JSON.parse(await readFile(runJson, 'utf8')))
  const benchmark = record.task.benchmark
  const score = benchmark !== undefined && options.scorer !== undefined
    ? await options.scorer(benchmark, join(runDir, 'workspace'), join(runDir, 'score'))
    : undefined
  const isolation = { image: tag, imageId: id, ...(networkRecord === null ? {} : { network: networkRecord }) }
  const updated = RunRecord.parse({ ...record, isolation, ...(score === undefined ? {} : { score }) })
  await writeFile(runJson, `${JSON.stringify(updated, null, 2)}\n`)
  return runJson
}

/**
 * The command that logs the bundled Codex in to the isolated runs' volume, by device code.
 * @param commit - commit whose image to use.
 * @returns the docker arguments, to run interactively.
 */
export function codexLoginArgs(commit: string): string[] {
  return [
    'run', '--rm', '-it',
    '--volume', `${CODEX_VOLUME}:/home/node/.codex`,
    '--entrypoint', 'sh',
    agentImageTag(commit),
    '-c', `exec node "$(readlink -f ${IMAGE_REPO}/packages/subagent/subagent-codex/node_modules/@openai/codex)/bin/codex.js" login --device-auth`,
  ]
}

/** Reads the HEAD commit, for the CLI. */
export function headCommit(repoRoot: string): string {
  return git(['rev-parse', 'HEAD'], repoRoot)
}
