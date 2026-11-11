# lab

Experiment infrastructure for testing a multi-model supervisor–worker
architecture on DeepSeek Harness (DSH). Everything the lab adds lives in this
directory, apart from changes to DSH's Claude Code and Codex delegation
adapters (an opt-in usage log and newer bundled CLIs) listed in
[NOTICE.md](NOTICE.md). The base is DSH
`dsh-v0.2.1-rc.5`.

## Layout

| Path | Contents |
| --- | --- |
| `harness/` | TypeScript tool that runs a task under a condition and records the result |
| `tasks/` | Task files: the prompt given to the agent and the gates that judge the outcome |
| `conditions/` | Condition files: how the agent is launched, plus DSH loader patches in `conditions/patches/` |
| `catalog/models.yaml` | Fixed model catalog: prices, plans and taste ranks, each with its source and query date |
| `superagent/` | [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) at commit `8c32a9dc5d`, imported with `git subtree` and unmodified |
| `superagent-lab/` | What the prototype needs to run offline: the `lab-task` Source, an offline stand-in for `gh`, and the lab's Delivery requirements prompt section |
| `results/` | Run outputs; ignored by git except where a run is committed on purpose |

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (the harness runs TypeScript directly through Node's type stripping)
- pnpm `11.28.5`, for example through `corepack pnpm`
- A DeepSeek API key
- For conditions that delegate: a Claude Code login on the host and a Codex login in `~/.codex`. The CLIs themselves are the ones DSH bundles: Claude Code 2.1.311 (Agent SDK 0.3.311) and Codex 0.167.0-alpha.3.2

## Setup

From the repository root:

```sh
corepack pnpm install --frozen-lockfile   # DSH workspace
corepack pnpm run build:artifacts         # DSH build used by source launches
cd lab
corepack pnpm install --frozen-lockfile   # lab workspace
corepack pnpm build                       # dsh-superagent, for the super-agent condition
cp .env.example .env                      # then set DEEPSEEK_API_KEY
corepack pnpm check                       # typecheck and tests of harness/ and superagent-lab/
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
| `events.ndjson` | DSH headless `--json` event stream (headless conditions) |
| `agent.stderr.log` | DSH diagnostics |
| `inbox.jsonl`, `outbox.jsonl` | The operator's messages and the agent's replies (super-agent condition) |
| `superagent/`, `tickets/` | The prototype's state directory, and one link per Ticket to `workspace/` (super-agent condition) |
| `gates/` | Output of each gate command |
| `run.json` | The run record (schema in `harness/src/record.ts`) |

Every run sets `DSH_TELEMETRY_MODE=DISABLED`.

## Models

| Role | Models | Access | Billing |
| --- | --- | --- | --- |
| Root agent (DSH) | `deepseek-flash` (V4.1 Flash), `deepseek-v4-pro` | DeepSeek API key | Per token, with weekday peak rates |
| Claude Code workers | `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | Host Claude Code login, through the bundled Claude Code 2.1.311 | Claude Max (5x) subscription |
| Codex workers | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna` | Codex login in `~/.codex`, through the bundled Codex 0.167.0-alpha.3.2 | ChatGPT Plus subscription |

Each worker model is its own delegation tool, such as `subagent_claude_opus`
or `subagent_codex_luna`; see `conditions/patches/worker-*.yml`. Both CLIs
are pinned by the DSH lockfile at the versions on the operator's machine (see
[NOTICE.md](NOTICE.md)), and each worker pins its model, so runs follow
neither the host's CLI updates nor its default models.

## Conditions

| Condition | What it runs |
| --- | --- |
| `baseline-headless` | One DSH session on DeepSeek V4.1 Flash, no delegation |
| `baseline-deepseek-v4-pro` | One DSH session on DeepSeek V4 Pro, no delegation |
| `deepseek-flash-with-workers` | One DSH session on V4.1 Flash with all eight worker tools; the agent decides on its own whether to delegate |
| `superagent-deepseek-flash` | The unmodified dsh-superagent prototype on V4.1 Flash, offline; see below |
| Supervisor with model selection | Planned |

## Measures

| Field in `run.json` | Definition |
| --- | --- |
| `usage[]` | Tokens per provider/model, summed over the run. `source: dsh-session` counts come from `assistant/message` events in every DSH session log, delegated sessions included; `source: adapter` counts come from `lab-usage.jsonl` |
| `usage[].inputTokens` | Uncached input. Codex reports input including cached input; the harness subtracts the cached part |
| `usage[].billing`, `cost`, `peakCalls` | From the catalog. Per-token calls are priced one by one at the rate in force at their event time; `peakCalls` counts those billed at peak rates. Subscription models have no cash cost |
| `usage[].nativeCostEstimateUsd` | Claude Code's own API-equivalent estimate for a subscription run; not a bill |
| `totalCost` | Cash cost of per-token models; null when a model is missing from the catalog or currencies differ |
| `followUpMessages` | Messages a person sent after the task: the human-attention measure. Headless conditions count messages with source kind `user` after the first one, in sessions of delegation depth 0; the super-agent condition counts operator messages in `inbox.jsonl` after the first |
| `superagent` | Super-agent condition only: `stopReason` (below), each Ticket's state, stage, outcome and summary, and the number of replies |
| `gates[]` | Exit status of each task gate, run in the workspace after the agent stops |
| `agent.wallMs` | Wall time of the agent process |
| `environment` | Repository commit, Node version, platform, the bundled Agent SDK, Claude Code and Codex versions, and the host Claude Code version for reference |

Session logs must be plain JSONL for the harness to read them. Every condition
applies `conditions/patches/plain-session-log.yml`, which turns off the
default Zstandard compression and changes nothing else.

## The super-agent condition

The prototype is run as its own documentation describes, on a DSH Web
profile made from the shipped template inside the run's `DSH_HOME`, with two
departures needed to run it without GitHub:

- **Account check.** The prototype requires a GitHub repository and an agent
  account with push access before it starts. Its GitHub Source is saved
  turned off, with `superagent-lab/bin/gh-offline` as the agent CLI. That
  script answers the two setup checks for a fictitious account and
  repository and fails every other call, so a worker that tries GitHub
  learns it cannot.
- **Where the task comes from and where the result goes.** The `lab-task`
  Source (`superagent-lab/src/index.ts`) turns each line of `inbox.jsonl`
  into a direct request from `operator`, the only sender on the allowed list,
  and appends the agent's messages to `outbox.jsonl`. Each Ticket's directory
  is a link to the run workspace, made by the prepare command. The Delivery
  requirements prompt section is replaced by
  `superagent-lab/prompts/delivery.md`, which says the directory is the
  deliverable; every other prompt section, the Policy rules and the Eval mode
  keep their defaults.

The harness configures the instance through the prototype's Management API,
posts the task and reads the Tickets every `pollSec` seconds. `stopReason`
records why it stopped: `settled` once every Ticket ended, `needs-person`
once the open Tickets all wait for a person, each after `quietSec` with
nothing in progress; `no-ticket` when none appeared within `noTicketMin`;
`timeout` after `timeoutMin`; `server-exited` if the server stopped on its
own. No one answers the agent during a run.

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
