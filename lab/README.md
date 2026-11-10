# lab

Experiment infrastructure for testing a multi-model supervisor–worker
architecture on DeepSeek Harness (DSH). Everything the lab adds lives in this
directory, apart from two small changes to DSH's Claude Code and Codex
delegation adapters listed in [NOTICE.md](NOTICE.md). The base is DSH
`dsh-v0.2.1-rc.5`.

## Layout

| Path | Contents |
| --- | --- |
| `harness/` | TypeScript tool that runs a task under a condition and records the result |
| `tasks/` | Task files: the prompt given to the agent and the gates that judge the outcome |
| `conditions/` | Condition files: how the agent is launched, plus DSH loader patches in `conditions/patches/` |
| `catalog/models.yaml` | Fixed model catalog: prices, plans and taste ranks, each with its source and query date |
| `superagent/` | [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) at commit `8c32a9dc5d`, imported with `git subtree` and unmodified |
| `results/` | Run outputs; ignored by git except where a run is committed on purpose |

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (the harness runs TypeScript directly through Node's type stripping)
- pnpm `11.28.5`, for example through `corepack pnpm`
- A DeepSeek API key
- For conditions that delegate: Claude Code signed in on the host (`claude` on `PATH`, 2.1.290 or newer for every pinned model) and a Codex login in `~/.codex`

## Setup

From the repository root:

```sh
corepack pnpm install --frozen-lockfile   # DSH workspace
corepack pnpm run build:artifacts         # DSH build used by source launches
cd lab
corepack pnpm install --frozen-lockfile   # lab workspace
cp .env.example .env                      # then set DEEPSEEK_API_KEY
corepack pnpm check                       # harness typecheck and tests
node harness/src/cli.ts validate          # tasks, conditions and catalog
```

The harness loads `lab/.env` on start; variables already set in the
environment win. `.env` is ignored by git.

## Running an experiment

```sh
cd lab
node harness/src/cli.ts run \
  --task tasks/t001-one-line-video-site.yaml \
  --condition conditions/baseline-headless.yaml
node harness/src/cli.ts summarize            # Markdown table of all runs
node harness/src/cli.ts summarize --format csv
```

Each run gets its own directory `results/<UTC time>-<task>-<condition>/`:

| File | Contents |
| --- | --- |
| `workspace/` | The agent's working directory, seeded from the task fixture if any |
| `dsh-home/` | A fresh `DSH_HOME`, so no profile, setting or session from elsewhere leaks in |
| `dsh-home/lab-usage.jsonl` | Native usage reports of Claude Code and Codex delegations |
| `events.ndjson` | DSH headless `--json` event stream |
| `agent.stderr.log` | DSH diagnostics |
| `gates/` | Output of each gate command |
| `run.json` | The run record (schema in `harness/src/record.ts`) |

Every run sets `DSH_TELEMETRY_MODE=DISABLED`.

## Models

| Role | Models | Access | Billing |
| --- | --- | --- | --- |
| Root agent (DSH) | `deepseek-flash` (V4.1 Flash), `deepseek-v4-pro` | DeepSeek API key | Per token, with weekday peak rates |
| Claude Code workers | `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | Host Claude Code login | Claude Max (5x) subscription |
| Codex workers | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Codex login in `~/.codex`, through the Codex CLI DSH bundles (0.153.4) | ChatGPT Plus subscription |

Each worker model is its own delegation tool, such as `subagent_claude_opus`
or `subagent_codex_luna`; see `conditions/patches/worker-*.yml`. The harness
points the Claude Code adapter at the host install through
`LAB_CLAUDE_EXECUTABLE`, because the CLI bundled with the Agent SDK (2.1.263)
does not support Opus 5.5 or Fable 5.2. Codex models are pinned because the
bundled Codex CLI may not support the operator's own Codex default.

## Conditions

| Condition | What it runs |
| --- | --- |
| `baseline-headless` | One DSH session on DeepSeek V4.1 Flash, no delegation |
| `baseline-deepseek-v4-pro` | One DSH session on DeepSeek V4 Pro, no delegation |
| `deepseek-flash-with-workers` | One DSH session on V4.1 Flash with all eight worker tools; the agent decides on its own whether to delegate |
| Original super-agent (`superagent/`) | Planned |
| Supervisor with model selection | Planned |

## Measures

| Field in `run.json` | Definition |
| --- | --- |
| `usage[]` | Tokens per provider/model, summed over the run. `source: dsh-session` counts come from `assistant/message` events in every DSH session log, delegated sessions included; `source: adapter` counts come from `lab-usage.jsonl` |
| `usage[].inputTokens` | Uncached input. Codex reports input including cached input; the harness subtracts the cached part |
| `usage[].billing`, `cost`, `peakCalls` | From the catalog. Per-token calls are priced one by one at the rate in force at their event time; `peakCalls` counts those billed at peak rates. Subscription models have no cash cost |
| `usage[].nativeCostEstimateUsd` | Claude Code's own API-equivalent estimate for a subscription run; not a bill |
| `totalCost` | Cash cost of per-token models; null when a model is missing from the catalog or currencies differ |
| `followUpMessages` | Messages with source kind `user` after the first one, in sessions of delegation depth 0: the human-attention measure |
| `gates[]` | Exit status of each task gate, run in the workspace after the agent stops |
| `agent.wallMs` | Wall time of the agent process |
| `environment` | Repository commit, Node version, platform, and the host Claude Code and bundled Codex versions |

Session logs must be plain JSONL for the harness to read them. Every condition
applies `conditions/patches/plain-session-log.yml`, which turns off the
default Zstandard compression and changes nothing else.

## Model catalog

`catalog/models.yaml` holds what the harness prices with and what a
supervisor can choose by: per-token prices with peak windows and holiday
exceptions, subscription plans, and placements on public blind-test
leaderboards (Arena WebDev and Design Arena for visual design, Arena
Creative Writing for copy). Every figure names its source and query date.
Re-check the placements against the live boards before publication, and add
Chinese public holidays to `exceptDates` as they are announced.

## Supervisor protocol

`harness/src/protocol.ts` defines the two documents the supervisor and the
collaborators exchange: the task sheet (supervisor to collaborator) and the
ticket (collaborator to supervisor). Conditions that implement the
architecture will validate every exchanged document against these schemas.
