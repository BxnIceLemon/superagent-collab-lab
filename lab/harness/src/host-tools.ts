import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Host CLIs a run may delegate to, recorded so a run can be reproduced. */
export interface HostTools {
  /** The host Claude Code install, used through LAB_CLAUDE_EXECUTABLE; null when absent. */
  claudeCode: { path: string; version: string } | null
  /** Version of the Codex CLI bundled with DSH's Codex adapter; null when not installed. */
  codexBundled: string | null
}

function claudeCode(): HostTools['claudeCode'] {
  const which = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' })
  const found = which.stdout.trim()
  if (which.status !== 0 || found === '') return null
  const path = realpathSync(found)
  const version = spawnSync(path, ['--version'], { encoding: 'utf8' })
  if (version.status !== 0) return null
  return { path, version: version.stdout.trim() }
}

function codexBundled(repoRoot: string): string | null {
  const require = createRequire(join(repoRoot, 'packages/subagent/subagent-codex/package.json'))
  try {
    return (require('@openai/codex/package.json') as { version: string }).version
  } catch {
    // DSH dependencies are not installed; Codex delegation cannot run either.
    return null
  }
}

/**
 * Finds the host CLIs used by delegation conditions.
 * @param repoRoot - root of the DSH checkout.
 * @returns paths and versions, null where a tool is missing.
 */
export function detectHostTools(repoRoot: string): HostTools {
  return { claudeCode: claudeCode(), codexBundled: codexBundled(repoRoot) }
}
