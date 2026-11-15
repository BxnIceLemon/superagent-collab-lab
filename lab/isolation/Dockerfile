# The clean environment an isolated lab run happens in. Built by
# `lab isolation build` from `git archive` of one commit, so the image holds
# exactly that commit's DSH, adapters, bundled CLIs and lab, and nothing of
# the operator's machine: no ~/.claude or ~/.codex settings, skills, plugins
# or instructions. Credentials are given per run; see lab/README.md.
FROM node:22.23.3-bookworm

# Tools an agent commonly needs to build and check its work, and node-pty's
# native build (python3, make, g++ from build-essential).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git jq python3 python3-pip python3-venv ripgrep unzip \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# The archive has no .git: the commit is passed in, for DSH's build metadata
# and for the harness, which records it as the run's repoCommit.
ARG LAB_REPO_COMMIT
ENV LAB_REPO_COMMIT=$LAB_REPO_COMMIT DSH_CLIENT_COMMIT_HASH=$LAB_REPO_COMMIT
WORKDIR /opt/lab-repo
COPY . .
RUN chown -R node:node /opt/lab-repo
USER node
RUN corepack pnpm install --frozen-lockfile \
 && corepack pnpm run build:artifacts \
 && cd lab \
 && corepack pnpm install --frozen-lockfile \
 && corepack pnpm build

# The Codex login lives in a volume mounted here; Claude Code gets a token.
RUN mkdir -p /home/node/.codex
WORKDIR /opt/lab-repo/lab
ENTRYPOINT ["node", "harness/src/cli.ts"]
