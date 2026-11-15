import { spawnSync } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { stringify } from 'yaml'
import { z } from 'zod'
import { readDocument } from './files.ts'

/**
 * Published benchmarks: where each is pinned, how its items become lab tasks.
 *
 * Benchmark code and data are fetched into `lab/.cache/` at the pinned commit
 * and never committed. Task files are generated there too, one per item.
 */

export const BenchmarkName = z.enum(['projecteval', 'e2edev', 'nl2repo'])
export type BenchmarkName = z.output<typeof BenchmarkName>

export const BenchmarkSource = z.object({
  name: BenchmarkName,
  title: z.string().min(1),
  repository: z.url(),
  commit: z.string().regex(/^[0-9a-f]{40}$/, 'a full commit hash'),
  license: z.string().nullable(),
  paper: z.url(),
})
export type BenchmarkSource = z.output<typeof BenchmarkSource>

export const BenchmarkSources = z.object({ version: z.literal(1), benchmarks: z.array(BenchmarkSource) })

/** Which item of which benchmark a task is, and at which commit it was generated. */
export const BenchmarkRef = z.object({
  name: BenchmarkName,
  item: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** ProjectEval input level: 1 natural-language prompt, 2 checklist, 3 skeleton. */
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
})
export type BenchmarkRef = z.output<typeof BenchmarkRef>

/**
 * Reads `benchmarks/sources.yaml`.
 * @param labDir - the lab directory.
 * @param name - the benchmark wanted.
 * @returns its pinned source.
 */
export async function benchmarkSource(labDir: string, name: BenchmarkName): Promise<BenchmarkSource> {
  const { benchmarks } = await readDocument(join(labDir, 'benchmarks/sources.yaml'), BenchmarkSources)
  const source = benchmarks.find(b => b.name === name)
  if (source === undefined) throw new Error(`benchmarks/sources.yaml has no benchmark ${name}`)
  return source
}

/** Where a benchmark's pinned checkout lives. */
export function checkoutDir(labDir: string, source: Pick<BenchmarkSource, 'name' | 'commit'>): string {
  return join(labDir, '.cache/benchmarks', `${source.name}-${source.commit.slice(0, 12)}`)
}

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/**
 * Fetches a benchmark at its pinned commit, once.
 * @param labDir - the lab directory.
 * @param source - the pinned source.
 * @returns the checkout directory.
 */
export async function fetchBenchmark(labDir: string, source: BenchmarkSource): Promise<string> {
  const dir = checkoutDir(labDir, source)
  if (await exists(dir)) {
    if (git(['rev-parse', 'HEAD'], dir) !== source.commit) throw new Error(`${dir} is not at ${source.commit}`)
    return dir
  }
  const partial = `${dir}.partial`
  await rm(partial, { recursive: true, force: true })
  await mkdir(partial, { recursive: true })
  git(['init', '--quiet'], partial)
  git(['fetch', '--quiet', '--depth', '1', source.repository, source.commit], partial)
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], partial)
  if (git(['rev-parse', 'HEAD'], partial) !== source.commit) throw new Error(`${source.repository} did not give ${source.commit}`)
  await rename(partial, dir)
  return dir
}

/** One generated lab task, before it is written. */
interface TaskDraft {
  id: string
  title: string
  prompt: string
  benchmark: BenchmarkRef
  /** Files placed in the workspace before the run, as a copy from these paths. */
  fixture: { from: string; to: string }[]
}

// ProjectEval

interface ProjectEvalProject {
  project_id: string
  project_type: string
  nl_prompt: string
  nl_checklist: unknown
  skeleton: unknown
}

/**
 * ProjectEval's answer prompt (prompt.py, `generate_answer`), asking for files
 * in the workspace instead of a JSON listing of them. As in run_reasoning.py,
 * websites are Django projects and the other types plain Python.
 */
export function projectEvalPrompt(project: ProjectEvalProject, level: 1 | 2 | 3): string {
  const description =
    level === 1 ? project.nl_prompt
    : level === 2 ? `Requirement checklist:\n${JSON.stringify(project.nl_checklist, null, 2)}`
    : `Project skeleton:\n${JSON.stringify(project.skeleton, null, 2)}`
  const website = project.project_type === 'website'
  return [
    description,
    '',
    `Build this as a ${website ? 'Django project in Python' : 'Python project'}, with all of its files, including the essential files to run the project, in the current directory.`,
    ...(website ? ['Recommend adding an id attribute to each HTML element and adding classes for them too.'] : []),
  ].join('\n')
}

async function projectEvalTasks(checkout: string, commit: string, level: 1 | 2 | 3): Promise<TaskDraft[]> {
  const projects = JSON.parse(await readFile(join(checkout, 'data/project_eval_project.json'), 'utf8')) as ProjectEvalProject[]
  return projects.map(project => ({
    id: `projecteval-p${project.project_id.padStart(2, '0')}-l${level}`,
    title: `ProjectEval ${project.project_id} (level ${level}): ${project.nl_prompt.slice(0, 80)}`,
    prompt: projectEvalPrompt(project, level),
    benchmark: { name: 'projecteval', item: project.project_id, commit, level },
    fixture: [],
  }))
}

// E2EDev

/** What run_behave_test.py leaves out when it copies the source project into a submission at test time. */
const E2EDEV_CODE = new Set(['.js', '.html', '.css', '.log'])
const E2EDEV_SKIP_FILES = new Set(['annotation.json', 'annotation_o.json', 'requirements.json'])
const E2EDEV_SKIP_DIRS = new Set(['info', 'features'])

/**
 * The files of an E2EDev project its prompt names, such as `img/img1.jpg`.
 *
 * Before testing, the evaluation copies every non-code file of the source
 * project into the submission. Those also include annotations and screenshots
 * of the finished application, so the agent is given only the files the
 * prompt refers to by path or name.
 * @param sourceProject - the project's `source_projcet` folder.
 * @param prompt - the project's prompt.
 * @returns paths relative to the source project.
 */
export async function e2edevAssets(sourceProject: string, prompt: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!E2EDEV_SKIP_DIRS.has(entry.name)) await walk(path)
        continue
      }
      const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase() : ''
      if (E2EDEV_CODE.has(ext) || E2EDEV_SKIP_FILES.has(entry.name)) continue
      const rel = relative(sourceProject, path)
      const folder = dirname(rel)
      const named = prompt.includes(rel) || prompt.includes(entry.name)
      const inNamedFolder = folder !== '.' && (prompt.includes(`${folder}/`) || prompt.includes(`'${folder}'`))
      if (named || inNamedFolder) found.push(rel)
    }
  }
  await walk(sourceProject)
  return found.sort()
}

async function e2edevTasks(checkout: string, commit: string): Promise<TaskDraft[]> {
  const data = join(checkout, 'E2EDev_data')
  const items = (await readdir(data, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()
  return Promise.all(items.map(async item => {
    const source = join(data, item, 'source_projcet')
    const prompt = await readFile(join(data, item, 'prompt.txt'), 'utf8')
    const assets = await e2edevAssets(source, prompt)
    return {
      id: `e2edev-${item.replace(/^E2ESD_Bench_/, '').toLowerCase()}`,
      title: `E2EDev ${item}`,
      prompt,
      benchmark: { name: 'e2edev' as const, item, commit },
      fixture: assets.map(a => ({ from: join(source, a), to: a })),
    }
  }))
}

// NL2Repo-Bench

/** The instruction NL2Repo-Bench gives its agent (openhands/openhands_app.py). */
export const NL2REPO_PROMPT =
  'According to the start.md in the workspace, implement the entire project as per the requirements specified in the document, ensuring that the final product can be directly run in the current directory. The running requirements should comply with the <API Usage Guide> section of the document. Please complete this task step by step.'

async function nl2repoTasks(checkout: string, commit: string): Promise<TaskDraft[]> {
  const data = join(checkout, 'test_files')
  const items = (await readdir(data, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()
  const drafts: TaskDraft[] = []
  for (const item of items) {
    // test_data_service.py reads the task's .md file; tasks without one are not runnable.
    if (!(await exists(join(data, item, 'start.md')))) continue
    drafts.push({
      id: `nl2repo-${item.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
      title: `NL2Repo-Bench ${item}`,
      prompt: NL2REPO_PROMPT,
      benchmark: { name: 'nl2repo', item, commit },
      fixture: [{ from: join(data, item, 'start.md'), to: 'start.md' }],
    })
  }
  return drafts
}

/**
 * Generates one lab task per benchmark item into `.cache/tasks/<benchmark>/`.
 * @param labDir - the lab directory.
 * @param source - the pinned source.
 * @param checkout - its checkout.
 * @param options - ProjectEval's input level.
 * @returns the task files written.
 */
export async function writeBenchmarkTasks(
  labDir: string,
  source: BenchmarkSource,
  checkout: string,
  options: { level?: 1 | 2 | 3 } = {},
): Promise<string[]> {
  const drafts =
    source.name === 'projecteval' ? await projectEvalTasks(checkout, source.commit, options.level ?? 1)
    : source.name === 'e2edev' ? await e2edevTasks(checkout, source.commit)
    : await nl2repoTasks(checkout, source.commit)
  const dir = join(labDir, '.cache/tasks', source.name)
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  for (const draft of drafts) {
    const fixtureDir = join(dir, draft.id)
    await rm(fixtureDir, { recursive: true, force: true })
    for (const f of draft.fixture) await cp(f.from, join(fixtureDir, f.to), { recursive: true })
    const task = {
      version: 1,
      id: draft.id,
      title: draft.title,
      prompt: draft.prompt,
      ...(draft.fixture.length > 0 ? { fixture: draft.id } : {}),
      benchmark: draft.benchmark,
    }
    const file = join(dir, `${draft.id}.yaml`)
    await writeFile(file, `# Generated by \`lab bench tasks ${source.name}\` from ${source.repository} at ${source.commit}.\n${stringify(task, { lineWidth: 0 })}`)
    files.push(file)
  }
  return files
}
