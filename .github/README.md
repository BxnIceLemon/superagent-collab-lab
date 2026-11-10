# superagent-collab-lab

Research repository for a multi-model supervisor–worker agent architecture,
built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH). A strong reasoning model splits the work, chooses a model for each
task and accepts the results; cheaper models do the execution. The lab
measures cost, human attention and outcome quality against a single-agent
baseline.

This is a fork of DSH pinned at `dsh-v0.2.1-rc.5`. It is not an official
DeepSeek project.

## Where things are

- [`lab/`](../lab/README.md): everything this project adds: the experiment harness, tasks, conditions, model catalog and the imported dsh-superagent-prototype. Start here.
- Everything else: DeepSeek Harness, unmodified. Its own README is [README.md](../README.md).

## Quick start

```sh
corepack pnpm install --frozen-lockfile && corepack pnpm run build:artifacts
cd lab && corepack pnpm install --frozen-lockfile && corepack pnpm check
```

Then see [lab/README.md](../lab/README.md) to run an experiment.

## License

The lab's own files are MIT licensed ([lab/LICENSE](../lab/LICENSE)). DeepSeek
Harness and dsh-superagent-prototype are MIT licensed by DeepSeek; see
[lab/NOTICE.md](../lab/NOTICE.md).

## Citation

Cite this repository with the metadata in [CITATION.cff](../CITATION.cff).
