# Notice

This repository is a fork of DeepSeek Harness and includes a copy of
dsh-superagent-prototype. Both are published by DeepSeek under the MIT
License. Their copyright and license notices are kept in place.

| Work | Version used | Location here | License |
| --- | --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | tag `dsh-v0.2.1-rc.5` (commit `b830ec950f`) | repository root | MIT, Copyright (c) 2026 DeepSeek; see [/LICENSE](../LICENSE) and [/THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |
| [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | commit `8c32a9dc5d` | `lab/superagent/` | MIT; see [superagent/LICENSE](superagent/LICENSE) |

"DeepSeek Harness" is a registered trademark of DeepSeek. This project is
built on DeepSeek Harness; it is not an official DeepSeek project and is not
endorsed by DeepSeek.

## Modifications to DeepSeek Harness

The Claude Code and Codex delegation adapters are changed in two ways.

**Opt-in usage log.** With `usageLog` unset, both behave exactly as upstream.

| Package | Change |
| --- | --- |
| `packages/subagent/subagent-claude-code` | `usageLog`: append each run's native SDK usage (`modelUsage`, `total_cost_usd`) to a JSONL file |
| `packages/subagent/subagent-codex` | `usageLog`: append each run's model and latest `thread/tokenUsage/updated` payload to a JSONL file |

Each package adds `src/usage-log.ts` and `tests/usage.spec.ts`, and documents
the new field in its README. Usage records never enter a model's context.

**Bundled CLI versions, matched to the operator's machine.**

| Dependency | Upstream | Here |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` (bundles Claude Code) | 0.3.263 (Claude Code 2.1.263) | 0.3.311 (Claude Code 2.1.311) |
| `@openai/codex` | 0.153.4 | 0.167.0-alpha.3.2 |

The newer Claude Code is needed for Opus 5.5 (2.1.280+) and Fable 5.2
(2.1.290+). The Codex app-server schema was regenerated and compared with
0.153.4 for every method and enum the adapter uses: the changes are new
optional fields and the `partial_answer` message phase, which the adapter
already handles. Version pins in `pnpm-workspace.yaml`, the lockfile, the
adapters' tests and READMEs, and `THIRD_PARTY_NOTICES.md` follow the new
versions; the adapters' unit, keyless real-product and credentialed
end-to-end tests pass. Archived design notes under `.agents/notes/` keep the
versions they were written for.

The lab's own work is confined to `lab/` (excluding `lab/superagent/`),
`.github/README.md` and `CITATION.cff`, and is licensed under
[lab/LICENSE](LICENSE). The prototype in `lab/superagent/` is unmodified.
`lab/superagent-lab/` runs it through its documented Source interface;
`lab/superagent-lab/src/host.ts` restates the type declarations of that
interface from the prototype.
