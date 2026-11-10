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

Two delegation adapters gain opt-in configuration. With the new fields
unset, both behave exactly as upstream.

| Package | Change |
| --- | --- |
| `packages/subagent/subagent-claude-code` | `usageLog`: append each run's native SDK usage (`modelUsage`, `total_cost_usd`) to a JSONL file. `executable`: run a given Claude Code executable through the SDK's `pathToClaudeCodeExecutable` instead of the bundled CLI |
| `packages/subagent/subagent-codex` | `usageLog`: append each run's model and latest `thread/tokenUsage/updated` payload to a JSONL file |

Each package adds `src/usage-log.ts` and `tests/usage.spec.ts`, and documents
the new fields in its README. Usage records never enter a model's context.

The lab's own work is confined to `lab/` (excluding `lab/superagent/`),
`.github/README.md` and `CITATION.cff`, and is licensed under
[lab/LICENSE](LICENSE). The prototype in `lab/superagent/` is unmodified.
