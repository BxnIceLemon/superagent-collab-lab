import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BenchmarkSources, e2edevAssets, NL2REPO_PROMPT, projectEvalPrompt, writeBenchmarkTasks, type BenchmarkSource } from '../src/benchmarks.ts'
import { loadTask } from '../src/experiment.ts'
import { readDocument } from '../src/files.ts'
import { runExperiment } from '../src/runner.ts'

const fakeDsh = fileURLToPath(new URL('fixtures/fake-dsh.mjs', import.meta.url))
const lab = fileURLToPath(new URL('../../', import.meta.url))
const commit = 'a'.repeat(40)
const source = (name: BenchmarkSource['name']): BenchmarkSource =>
  ({ name, title: name, repository: 'https://example.com/r', commit, license: null, paper: 'https://example.com/p' })

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lab-bench-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(path: string, text = 'x'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

describe('shipped benchmark sources', () => {
  it('pin every benchmark to a full commit', async () => {
    const { benchmarks } = await readDocument(join(lab, 'benchmarks/sources.yaml'), BenchmarkSources)
    expect(benchmarks.map(b => b.name)).toEqual(['projecteval', 'e2edev', 'nl2repo'])
  })
})

describe('projectEvalPrompt', () => {
  const project = { project_id: '1', project_type: 'website', nl_prompt: 'Create a BMI page.', nl_checklist: [{ page: 'Home' }], skeleton: [{ file: 'a.py' }] }

  it('gives the level 1 prompt, the checklist or the skeleton, and the stack', () => {
    expect(projectEvalPrompt(project, 1)).toBe([
      'Create a BMI page.',
      '',
      'Build this as a Django project in Python, with all of its files, including the essential files to run the project, in the current directory.',
      'Recommend adding an id attribute to each HTML element and adding classes for them too.',
    ].join('\n'))
    expect(projectEvalPrompt(project, 2)).toContain('Requirement checklist:\n[\n  {\n    "page": "Home"')
    expect(projectEvalPrompt(project, 3)).toContain('Project skeleton:')
    const batch = projectEvalPrompt({ ...project, project_type: 'batch' }, 1)
    expect(batch).toContain('as a Python project')
    expect(batch).not.toContain('HTML')
  })
})

describe('e2edevAssets', () => {
  it('gives the files the prompt names, by path, name or folder, and nothing else', async () => {
    const project = join(dir, 'source_projcet')
    for (const f of ['img/img1.jpg', 'tunes/a.wav', 'tunes/k.wav', 'snap.PNG', 'index.html', 'info/info.json', 'annotation/1/step_1.py', 'logo.jfif'])
      await put(join(project, f))
    const prompt = "Images such as 'img/img1.jpg'; sounds in the 'tunes' folder; the logo is logo.jfif."
    expect(await e2edevAssets(project, prompt)).toEqual(['img/img1.jpg', 'logo.jfif', 'tunes/a.wav', 'tunes/k.wav'])
  })
})

describe('writeBenchmarkTasks', () => {
  it('writes loadable ProjectEval tasks for the chosen level', async () => {
    const checkout = join(dir, 'pe')
    await put(join(checkout, 'data/project_eval_project.json'), JSON.stringify([
      { project_id: '7', project_type: 'website', nl_prompt: 'Budget app.', nl_checklist: [], skeleton: [] },
    ]))
    const [file] = await writeBenchmarkTasks(dir, source('projecteval'), checkout, { level: 2 })
    const task = await loadTask(file!)
    expect(task.value).toMatchObject({ id: 'projecteval-p07-l2', benchmark: { name: 'projecteval', item: '7', commit, level: 2 }, gates: [] })
    expect(task.value.fixture).toBeUndefined()
  })

  it('writes E2EDev tasks with their prompt verbatim and the named assets as fixture', async () => {
    const checkout = join(dir, 'e2e')
    await put(join(checkout, 'E2EDev_data/E2ESD_Bench_03/prompt.txt'), '  Build it with img/a.png.\n')
    await put(join(checkout, 'E2EDev_data/E2ESD_Bench_03/source_projcet/img/a.png'), 'png')
    await put(join(checkout, 'E2EDev_data/E2ESD_Bench_03/source_projcet/index.html'), '<html>')
    const [file] = await writeBenchmarkTasks(dir, source('e2edev'), checkout)
    const task = await loadTask(file!)
    expect(task.value).toMatchObject({ id: 'e2edev-03', prompt: '  Build it with img/a.png.\n', benchmark: { name: 'e2edev', item: 'E2ESD_Bench_03' } })
    expect(await readdir(task.value.fixture!, { recursive: true })).toEqual(['img', 'img/a.png'])
  })

  it('writes NL2Repo-Bench tasks with start.md as fixture and skips tasks without it', async () => {
    const checkout = join(dir, 'nl')
    await put(join(checkout, 'test_files/math-verify/start.md'), '# Goals')
    await put(join(checkout, 'test_files/broken/test_case_count.txt'), '3')
    const files = await writeBenchmarkTasks(dir, source('nl2repo'), checkout)
    expect(files).toHaveLength(1)
    const task = await loadTask(files[0]!)
    expect(task.value).toMatchObject({ id: 'nl2repo-math-verify', prompt: NL2REPO_PROMPT, benchmark: { name: 'nl2repo', item: 'math-verify' } })
    expect(await readFile(join(task.value.fixture!, 'start.md'), 'utf8')).toBe('# Goals')
  })
})

describe('runExperiment on a benchmark task', () => {
  it('scores the workspace after the gates and records the score', async () => {
    const benchmark = { name: 'nl2repo' as const, item: 'math-verify', commit }
    const seen: string[] = []
    const record = await runExperiment({
      repoRoot: dir,
      resultsDir: join(dir, 'results'),
      task: { file: '/t.yaml', value: { version: 1, id: 'nl2repo-math-verify', title: 'x', prompt: 'build', gates: [], benchmark } },
      condition: { file: '/c.yaml', value: { version: 1, id: 'c', description: 'x', launcher: 'dsh-headless', patches: [], env: {} } },
      launcher: { command: process.execPath, args: [fakeDsh], env: {} },
      hostTools: { claudeCodeBundled: null, codexBundled: null, claudeCodeHost: null },
      now: () => new Date('2026-11-10T08:00:00.000Z'),
      scorer: async (ref, workspace, outDir) => {
        seen.push(ref.item, workspace, outDir)
        return {
          benchmark: ref.name, item: ref.item, level: null, sourceCommit: ref.commit,
          scorerImage: { tag: 'collab-lab-scorer-nl2repo:aaaaaaaaaaaa', id: 'sha256:1' },
          status: 'ok', metrics: { passed: 3, cases: 4, passRate: 0.75 },
          judgeModel: null, testImage: null, error: null, wallMs: 1,
        }
      },
    })
    const runDir = join(dir, 'results', record.runId)
    expect(seen).toEqual(['math-verify', join(runDir, 'workspace'), join(runDir, 'score')])
    expect(record.task.benchmark).toEqual(benchmark)
    expect(record.score).toMatchObject({ status: 'ok', metrics: { passRate: 0.75 } })

    const skipped = await runExperiment({
      repoRoot: dir,
      resultsDir: join(dir, 'results'),
      task: { file: '/t.yaml', value: { version: 1, id: 'nl2repo-other', title: 'x', prompt: 'build', gates: [], benchmark } },
      condition: { file: '/c.yaml', value: { version: 1, id: 'c', description: 'x', launcher: 'dsh-headless', patches: [], env: {} } },
      launcher: { command: process.execPath, args: [fakeDsh], env: {} },
      hostTools: { claudeCodeBundled: null, codexBundled: null, claudeCodeHost: null },
      scorer: false,
    })
    expect(skipped.score).toBeUndefined()
  })
})
