import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { benchmarkSource, BenchmarkName, BenchmarkSources, fetchBenchmark, writeBenchmarkTasks } from './benchmarks.ts'
import { ModelCatalog } from './catalog.ts'
import { loadCondition, loadTask } from './experiment.ts'
import { InputFileError, readDocument } from './files.ts'
import { buildAgentImage, codexLoginArgs, headCommit, runIsolated } from './isolated.ts'
import { RunRecord } from './record.ts'
import { imageScorer, runExperiment } from './runner.ts'
import { buildScorerImage } from './scoring.ts'
import { readRuns, toCsv, toMarkdown } from './summarize.ts'

const LAB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(LAB_DIR, '..')

/** Loads credentials from the git-ignored lab/.env; variables already set win. */
function loadLocalEnv(): void {
  try {
    process.loadEnvFile(join(LAB_DIR, '.env'))
  } catch (error) {
    // No .env is fine: credentials may come from the caller's environment.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const USAGE = `Usage:
  lab run --task <file> --condition <file> [--catalog <file>] [--results <dir>] [--isolated] [--no-score]
  lab summarize [--results <dir>] [--format md|csv]
  lab validate
  lab bench fetch <benchmark|all>        clone the pinned benchmark into .cache/benchmarks/
  lab bench images <benchmark|all>       build the scorer images
  lab bench tasks <benchmark> [--level 1|2|3]
                                         write one task per item into .cache/tasks/<benchmark>/
  lab bench score --run <dir>            score (again) a run's workspace
  lab isolation build                    build the agent image from HEAD
  lab isolation codex-login              log the bundled Codex in to the isolated runs' volume

Benchmarks: ${BenchmarkName.options.join(', ')}.
Paths are relative to the current directory. Defaults: --catalog catalog/models.yaml,
--results results/ (both under lab/).`

async function yamlFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir)
  return names.filter(n => /\.ya?ml$/.test(n)).map(n => join(dir, n))
}

function benchmarks(name: string | undefined): BenchmarkName[] {
  if (name === 'all') return [...BenchmarkName.options]
  return [BenchmarkName.parse(name)]
}

async function bench(args: string[], values: { level?: string; run?: string }): Promise<number> {
  const [action, name] = args
  switch (action) {
    case 'fetch':
      for (const b of benchmarks(name)) process.stdout.write(`${await fetchBenchmark(LAB_DIR, await benchmarkSource(LAB_DIR, b))}\n`)
      return 0
    case 'images': {
      const logs = join(LAB_DIR, '.cache/logs')
      await mkdir(logs, { recursive: true })
      for (const b of benchmarks(name)) {
        const source = await benchmarkSource(LAB_DIR, b)
        await fetchBenchmark(LAB_DIR, source)
        process.stdout.write(`${await buildScorerImage(LAB_DIR, source, join(logs, `scorer-${b}.log`))}\n`)
      }
      return 0
    }
    case 'tasks': {
      const source = await benchmarkSource(LAB_DIR, BenchmarkName.parse(name))
      const level = values.level === undefined ? undefined : (Number(values.level) as 1 | 2 | 3)
      if (level !== undefined && ![1, 2, 3].includes(level)) throw new Error('--level is 1, 2 or 3')
      const files = await writeBenchmarkTasks(LAB_DIR, source, await fetchBenchmark(LAB_DIR, source), { level })
      process.stdout.write(`${files.length} tasks in ${dirname(files[0] ?? join(LAB_DIR, '.cache/tasks', source.name))}\n`)
      return 0
    }
    case 'score': {
      if (values.run === undefined) break
      const runJson = join(resolve(values.run), 'run.json')
      const record = RunRecord.parse(JSON.parse(await readFile(runJson, 'utf8')))
      if (record.task.benchmark === undefined) throw new Error(`${runJson} is not a benchmark task`)
      const score = await imageScorer(LAB_DIR)(record.task.benchmark, join(resolve(values.run), 'workspace'), join(resolve(values.run), 'score'))
      await writeFile(runJson, `${JSON.stringify(RunRecord.parse({ ...record, score }), null, 2)}\n`)
      process.stdout.write(`${JSON.stringify(score)}\n`)
      return score.status === 'ok' ? 0 : 1
    }
  }
  process.stderr.write(`${USAGE}\n`)
  return 2
}

async function isolation(action: string | undefined): Promise<number> {
  switch (action) {
    case 'build': {
      const logs = join(LAB_DIR, '.cache/logs')
      await mkdir(logs, { recursive: true })
      const built = await buildAgentImage(REPO_ROOT, join(logs, 'agent-image.log'))
      if (built.uncommitted) process.stderr.write('lab: the working tree has uncommitted changes; the image holds HEAD only\n')
      process.stdout.write(`${built.tag}\n`)
      return 0
    }
    case 'codex-login':
      return spawnSync('docker', codexLoginArgs(headCommit(REPO_ROOT)), { stdio: 'inherit' }).status ?? 1
  }
  process.stderr.write(`${USAGE}\n`)
  return 2
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      task: { type: 'string' },
      condition: { type: 'string' },
      catalog: { type: 'string', default: join(LAB_DIR, 'catalog/models.yaml') },
      results: { type: 'string', default: join(LAB_DIR, 'results') },
      format: { type: 'string', default: 'md' },
      isolated: { type: 'boolean', default: false },
      'no-score': { type: 'boolean', default: false },
      level: { type: 'string' },
      run: { type: 'string' },
    },
  })

  switch (command) {
    case 'run': {
      if (values.task === undefined || values.condition === undefined) {
        process.stderr.write(`${USAGE}\n`)
        return 2
      }
      if (values.isolated) {
        const runJson = await runIsolated({
          repoRoot: REPO_ROOT,
          labDir: LAB_DIR,
          resultsDir: resolve(values.results),
          taskFile: resolve(values.task),
          conditionFile: resolve(values.condition),
          ...(values['no-score'] ? {} : { scorer: imageScorer(LAB_DIR) }),
        })
        process.stdout.write(`${runJson}\n`)
        return 0
      }
      const record = await runExperiment({
        repoRoot: REPO_ROOT,
        resultsDir: resolve(values.results),
        task: await loadTask(values.task),
        condition: await loadCondition(values.condition),
        catalog: await readDocument(resolve(values.catalog), ModelCatalog),
        ...(values['no-score'] ? { scorer: false as const } : {}),
      })
      process.stdout.write(`${join(resolve(values.results), record.runId, 'run.json')}\n`)
      return record.agent.code === 0 ? 0 : 1
    }
    case 'summarize': {
      const runs = await readRuns(resolve(values.results))
      process.stdout.write(values.format === 'csv' ? toCsv(runs) : toMarkdown(runs))
      return 0
    }
    case 'validate': {
      for (const file of await yamlFiles(join(LAB_DIR, 'tasks'))) await loadTask(file)
      for (const file of await yamlFiles(join(LAB_DIR, 'conditions'))) await loadCondition(file)
      await readDocument(join(LAB_DIR, 'catalog/models.yaml'), ModelCatalog)
      await readDocument(join(LAB_DIR, 'benchmarks/sources.yaml'), BenchmarkSources)
      process.stdout.write('tasks, conditions, catalog and benchmark sources are valid\n')
      return 0
    }
    case 'bench':
      return bench(positionals, values)
    case 'isolation':
      return isolation(positionals[0])
    default:
      process.stderr.write(`${USAGE}\n`)
      return 2
  }
}

loadLocalEnv()
main(process.argv.slice(2)).then(
  code => process.exit(code),
  (error: unknown) => {
    const message = error instanceof InputFileError ? error.message : String((error as Error).stack ?? error)
    process.stderr.write(`lab: ${message}\n`)
    process.exit(1)
  },
)
