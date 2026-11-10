import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Delegation CLIs a run may use, recorded so a run can be reproduced. */
export interface HostTools {
  /** Agent SDK and Claude Code bundled with DSH's Claude Code adapter; null when not installed. */
  claudeCodeBundled: { sdk: string; claudeCode: string } | null
  /** Version of the Codex CLI bundled with DSH's Codex adapter; null when not installed. */
  codexBundled: string | null
  /** The host's own Claude Code, for reference only: runs use the bundled CLI. */
  claudeCodeHost: string | null
}

function packageJson(repoRoot: string, adapter: string, name: string): Record<string, unknown> | null {
  const require = createRequire(join(repoRoot, 'packages/subagent', adapter, 'package.json'))
  try {
    return require(`${name}/package.json`) as Record<string, unknown>
  } catch {
    // Not exported by this package; find it from the entry point instead.
  }
  try {
    let dir = dirname(require.resolve(name))
    while (dir !== dirname(dir)) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
        if (manifest.name === name) return manifest
      } catch {
        // Not the package root yet; keep walking up.
      }
      dir = dirname(dir)
    }
    return null
  } catch {
    // DSH dependencies are not installed; delegation cannot run either.
    return null
  }
}

function claudeCodeHost(): string | null {
  const version = spawnSync('sh', ['-c', 'claude --version'], { encoding: 'utf8' })
  return version.status === 0 ? version.stdout.trim() : null
}

/**
 * Finds the versions of the delegation CLIs.
 * @param repoRoot - root of the DSH checkout.
 * @returns bundled versions, and the host Claude Code for reference; null where missing.
 */
export function detectHostTools(repoRoot: string): HostTools {
  const sdk = packageJson(repoRoot, 'subagent-claude-code', '@anthropic-ai/claude-agent-sdk')
  const codex = packageJson(repoRoot, 'subagent-codex', '@openai/codex')
  return {
    claudeCodeBundled:
      sdk === null ? null : { sdk: String(sdk.version), claudeCode: String(sdk.claudeCodeVersion) },
    codexBundled: codex === null ? null : String(codex.version),
    claudeCodeHost: claudeCodeHost(),
  }
}
