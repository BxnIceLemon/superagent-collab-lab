import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ModelCatalog } from './catalog.ts'
import { loadCondition, loadTask } from './experiment.ts'
import { InputFileError, readDocument } from './files.ts'
import { runExperiment } from './runner.ts'
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
  lab run --task <file> --condition <file> [--catalog <file>] [--results <dir>]
  lab summarize [--results <dir>] [--format md|csv]
  lab validate

Paths are relative to the current directory. Defaults: --catalog catalog/models.yaml,
--results results/ (both under lab/).`

async function yamlFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir)
  return names.filter(n => /\.ya?ml$/.test(n)).map(n => join(dir, n))
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      task: { type: 'string' },
      condition: { type: 'string' },
      catalog: { type: 'string', default: join(LAB_DIR, 'catalog/models.yaml') },
      results: { type: 'string', default: join(LAB_DIR, 'results') },
      format: { type: 'string', default: 'md' },
    },
  })

  switch (command) {
    case 'run': {
      if (values.task === undefined || values.condition === undefined) {
        process.stderr.write(`${USAGE}\n`)
        return 2
      }
      const record = await runExperiment({
        repoRoot: REPO_ROOT,
        resultsDir: resolve(values.results),
        task: await loadTask(values.task),
        condition: await loadCondition(values.condition),
        catalog: await readDocument(resolve(values.catalog), ModelCatalog),
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
      process.stdout.write('tasks, conditions and catalog are valid\n')
      return 0
    }
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
