# lab

Experiment infrastructure for testing a multi-model supervisor–worker
architecture on DeepSeek Harness (DSH). Everything the lab adds lives in this
directory; the rest of the repository is DSH `dsh-v0.2.1-rc.5`, unmodified.

## Layout

| Path | Contents |
| --- | --- |
| `harness/` | TypeScript tool that runs a task under a condition and records the result |
| `tasks/` | Task files: the prompt given to the agent and the gates that judge the outcome |
| `conditions/` | Condition files: how the agent is launched, plus DSH loader patches |
| `catalog/models.yaml` | Fixed model catalog: prices, benchmark scores and taste ranks, each with its source and query date |
| `superagent/` | [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) at commit `8c32a9dc5d`, imported with `git subtree` and unmodified |
| `results/` | Run outputs; ignored by git except where a run is committed on purpose |

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (the harness runs TypeScript directly through Node's type stripping)
- pnpm `11.28.5`, for example through `corepack pnpm`
- An API key for the model provider a condition uses, such as `DEEPSEEK_API_KEY`

## Setup

From the repository root:

```sh
corepack pnpm install --frozen-lockfile   # DSH workspace
corepack pnpm run build:artifacts         # DSH build used by source launches
cd lab
corepack pnpm install --frozen-lockfile   # lab workspace
corepack pnpm check                       # harness typecheck and tests
node harness/src/cli.ts validate          # tasks, conditions and catalog
```

## Running an experiment

```sh
cd lab
DEEPSEEK_API_KEY=... node harness/src/cli.ts run \
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
| `events.ndjson` | DSH headless `--json` event stream |
| `agent.stderr.log` | DSH diagnostics |
| `gates/` | Output of each gate command |
| `run.json` | The run record (schema in `harness/src/record.ts`) |

## Measures

| Field in `run.json` | Definition |
| --- | --- |
| `usage[]` | Tokens per provider/model, summed over every session of the run, delegated ones included, from `assistant/message` events in the session logs |
| `usage[].cost`, `totalCost` | Tokens priced with `catalog/models.yaml`; null when a model is missing from the catalog or currencies differ |
| `followUpMessages` | Messages with source kind `user` after the first one, in sessions of delegation depth 0: the human-attention measure |
| `gates[]` | Exit status of each task gate, run in the workspace after the agent stops |
| `agent.wallMs` | Wall time of the agent process |
| `environment.repoCommit` | Commit of this repository the run used |

Session logs must be plain JSONL for the harness to read them. Every condition
applies `conditions/patches/plain-session-log.yml`, which turns off the
default Zstandard compression and changes nothing else.

## Conditions

| Condition | Status |
| --- | --- |
| `baseline-headless` | Ready. One DSH headless session, the profile's default model, no supervisor |
| Original super-agent (`superagent/`) | Planned |
| Supervisor with model selection | Planned |

## Supervisor protocol

`harness/src/protocol.ts` defines the two documents the supervisor and the
collaborators exchange: the task sheet (supervisor to collaborator) and the
ticket (collaborator to supervisor). Conditions that implement the
architecture will validate every exchanged document against these schemas.

## Changes to upstream code

The lab does not modify DSH or the imported prototype. A later change to
either will be its own commit, listed in [NOTICE.md](NOTICE.md).
