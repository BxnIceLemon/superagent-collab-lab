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
| `benchmarks/` | The published benchmarks the lab runs, each pinned to a commit (`sources.yaml`), and the image each is scored in (`scorers/`) |
| `isolation/` | The image an isolated run happens in |
| `.cache/` | Ignored by git: benchmark checkouts, generated benchmark tasks, image build contexts and logs |
| `results/` | Run outputs; ignored by git except where a run is committed on purpose |

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (the harness runs TypeScript directly through Node's type stripping)
- pnpm `11.28.5`, for example through `corepack pnpm`
- A DeepSeek API key
- For conditions that delegate: a Claude Code login on the host and a Codex login in `~/.codex`. The CLIs themselves are the ones DSH bundles: Claude Code 2.1.311 (Agent SDK 0.3.311) and Codex 0.167.0-alpha.3.2
- For benchmarks and isolated runs: Docker, and git. On macOS the lab uses its own Colima VM; see [Docker on macOS](#docker-on-macos)

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
| Claude Code workers | `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | Host Claude Code login, or in an isolated run a token from `claude setup-token`, through the bundled Claude Code 2.1.311 | Claude Max (5x) subscription |
| Codex workers | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna` | Codex login in `~/.codex`, or in an isolated run in the lab's own Codex volume, through the bundled Codex 0.167.0-alpha.3.2 | ChatGPT Plus subscription |

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
| `score` | Benchmark tasks only: the benchmark's own evaluation of the workspace, with the benchmark commit and scorer image it used; see [Benchmarks](#benchmarks) |
| `isolation` | Isolated runs only: the agent image tag and id |
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

## Benchmarks

The paper's benchmarks are run with their authors' own evaluation code. None
of their code or data is committed here: `benchmarks/sources.yaml` pins each
to one commit of its repository, and the lab fetches that commit into
`.cache/benchmarks/`.

| Benchmark | Commit | License | Items | Score in `run.json` |
| --- | --- | --- | --- | --- |
| [ProjectEval](https://github.com/RyanLoil/ProjectEval) | `578b2055d5` | GPL-3.0 | 20 projects, input levels 1 to 3 | `passed` of `cases`: test functions passed, plus one for the project running at all, as the judge counts them; the paper's pass@1 is the sum over all 20 projects divided by 284 |
| [E2EDev](https://github.com/SCUNLP/E2EDev) | `d280dd144f` | none given | 46 projects | `passedRequirements` of `requirements` (a requirement passes when all its BDD tests pass), `passedCases` of `cases`, and `finalScore`, 0.6 × requirement accuracy + 0.4 × test accuracy, from E2EDev's `Metrics/effectiveness.py` |
| [NL2Repo-Bench](https://github.com/multimodal-art-projection/NL2RepoBench) | `781a1da1ee` | none given | 104 libraries | `passed` of `cases` pytest tests, and `passRate`, capped at 1 as the benchmark does |

```sh
cd lab
node harness/src/cli.ts bench fetch all          # clone the pinned commits
node harness/src/cli.ts bench images all         # build the three scorer images
node harness/src/cli.ts bench tasks projecteval  # --level 2 or 3 for the other inputs
node harness/src/cli.ts bench tasks e2edev
node harness/src/cli.ts bench tasks nl2repo
node harness/src/cli.ts run --isolated \
  --task .cache/tasks/e2edev/e2edev-01.yaml --condition conditions/baseline-headless.yaml
```

`bench tasks` writes one task per item to `.cache/tasks/<benchmark>/`, with
the benchmark recorded in it (`benchmark.name`, `item`, `commit`). After the
gates, the harness scores the workspace in the benchmark's scorer image, with
the checkout and the workspace mounted read-only; the scorer works on a copy
and writes its outputs to the run's `score/`. `bench score --run <dir>`
scores a finished run again.

What the agent is given, and the departures from each benchmark's own
harness:

- **ProjectEval.** The prompt is ProjectEval's answer prompt (`prompt.py`,
  `generate_answer`) asking for the files in the workspace rather than a JSON
  listing of them: the level's input (the one-sentence prompt, the checklist
  or the skeleton), and as in `run_reasoning.py`, Django for websites and
  plain Python otherwise. The scorer converts the workspace with ProjectEval's
  `tools/file_transform.py`, leaving out `.git`, virtual environments and
  caches, and runs its `JudgeController` for that one project with the
  packages and initiation `run_judge.py` sets. The judge asks a model for the
  test parameters (element ids and URLs) by reading the submitted code; the
  lab fixes that model to `deepseek-flash` for every condition, through
  ProjectEval's own DeepSeek class, so the scorer needs `DEEPSEEK_API_KEY`.
  That model's usage is evaluation cost, not counted in the run. Two
  runtime adaptations let the judge, written for Windows, run on Linux
  without changing its code: the Django server start waits until port 8000
  accepts connections (the judge visits the home page at once, before the
  server has bound), and `signal.CTRL_BREAK_EVENT`, which Linux lacks, stops
  the server as SIGTERM. The image adds `sympy` and `scikit-learn`, which
  ProjectEval imports but does not list. Its canonical answers for projects
  1, 14 and 16 score full marks in the scorer.
- **E2EDev.** The prompt is the project's `prompt.txt`, verbatim. Before
  testing, E2EDev copies every non-code file of the original project into the
  submission; those include annotations and screenshots of the finished
  application, so the agent is given only the files its prompt names by
  path, name or folder. The scorer calls `run_behave_test.main()` and
  `Metrics/effectiveness.main()` unchanged. The original application of
  project 08 passes 10 of its 11 tests in the scorer; the eleventh has step
  code that does not parse, so no submission can pass it.
- **NL2Repo-Bench.** The workspace starts with the task's `start.md`, and the
  prompt is the instruction the benchmark gives OpenHands. The scorer calls
  `post_process_task()` unchanged: it removes packaging and test files from a
  copy of the workspace, builds it onto the task's published test image
  (`ghcr.io/multimodal-art-projection/nl2repobench/<task>:1.0`, linux/amd64)
  and runs the task's test commands. The image digest is recorded. The
  upstream source of python-decouple passes all 67 tests of `decouple`.
- **Browsers.** ProjectEval and E2EDev drive Google Chrome; their scorer
  images use Debian's Chromium, because Google Chrome has no Linux arm64
  build, with Selenium pointed at Debian's driver (`SE_CHROMEDRIVER`)
  because Selenium Manager has no Linux arm64 build either. E2EDev's tests
  open a visible window, so they run under Xvfb, and Chromium runs under the
  process name `chrome`, which E2EDev's runner looks for to close each test's
  browser.

Scorer package versions are in each image's
`/usr/local/share/scorer-packages.txt`. E2EDev's and NL2Repo-Bench's
repositories carry no license, so the lab only runs them and cites them.

## Isolated runs

`run --isolated` runs the agent in a fresh container built from one commit
of this repository, and scores the workspace afterwards outside it. The
container holds that commit's DSH, delegation adapters, bundled CLIs and lab,
and nothing of the operator's machine: there is no `~/.claude` or `~/.codex`
with its settings, skills, plugins or instructions. It mounts only the run's
results directory and the generated benchmark tasks (read-only).

```sh
cd lab
git status                                  # the image is built from HEAD
node harness/src/cli.ts isolation build     # collab-lab-agent:<commit>
node harness/src/cli.ts isolation codex-login   # once, for Codex workers
node harness/src/cli.ts run --isolated --task <file> --condition <file>
```

Task and condition files must be committed, or be generated benchmark tasks.
Credentials are passed per run, by variable name, so their values never
appear in command lines or records:

| Credential | How it reaches the container |
| --- | --- |
| `DEEPSEEK_API_KEY` | From `lab/.env` or the environment |
| `CLAUDE_CODE_OAUTH_TOKEN` | A long-lived token from `claude setup-token`, set in `lab/.env`. DSH removes credential-like variables from child processes, so `worker-claude-code.yml` hands it to the adapter explicitly |
| Codex login | The Docker volume `collab-lab-codex`, mounted as the container's `~/.codex`. `isolation codex-login` signs the bundled Codex in by device code; it never touches the operator's own `~/.codex` |

### Docker on macOS

The lab uses its own Colima profile, so the operator's default VM is left
alone. Rosetta lets the arm64 VM run NL2Repo-Bench's amd64 test images, and
only this checkout is shared with the VM:

```sh
colima start lab --cpu 6 --memory 8 --disk 120 --vm-type vz --vz-rosetta \
  --mount-type virtiofs --mount "$(git rev-parse --show-toplevel):w"
docker context use colima-lab
```

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
