# @rematch/server as one always-on Node process (Fly.io, or any Docker host).
#
# Not used by the submission's live URL (zero-spend decision, 2026-09-11 — see README
# "Deploy"). Verified: builds, boots fallback-only, ran a real loop on Fly until the
# no-card trial stopped the machine. `docker run -e REMATCH_PROVIDER=none` to try it.
#
# There is no build step on purpose: every workspace package exports `.ts` and runs
# under Node's native type stripping, exactly as `pnpm dev` does. What the image needs
# is the *source tree* of the server's dependency closure — contract, engine, sandbox,
# harness, agents, server — plus the three things read from disk at runtime:
#   packages/server/fallback/      the balance-tested strategy pool (boot fails without it)
#   packages/contract/README.md    the Boss Contract doc the Coder is briefed with
#   packages/contract/src/types.ts same, the types half
# The web package is not here: it is a static Vite build, deployed separately.
#
# Build context is the repo root (workspace install needs the lockfile and every
# package.json). `.dockerignore` keeps tests, docs, artifacts and web out.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app

# Manifests first, so the install layer is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY packages/engine/package.json   packages/engine/
COPY packages/sandbox/package.json  packages/sandbox/
COPY packages/harness/package.json  packages/harness/
COPY packages/agents/package.json   packages/agents/
COPY packages/server/package.json   packages/server/

# `--filter @rematch/server...` = the server and everything it depends on.
# `--ignore-scripts` skips the root `prepare` (a git hook install; no git here).
# `--prod` drops vitest/typescript/playwright — nothing at runtime needs them.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @rematch/server...

# Source of the six packages. Whole directories, so the runtime reads above keep
# working without a list that drifts; `.dockerignore` removes the tests.
COPY packages/contract packages/contract
COPY packages/engine   packages/engine
COPY packages/sandbox  packages/sandbox
COPY packages/harness  packages/harness
COPY packages/agents   packages/agents
COPY packages/server   packages/server

# Container networking: bind all interfaces. The rest of the config is env on the
# host (see fly.toml [env] and README "Deploy").
ENV HOST=0.0.0.0
ENV PORT=8080
ENV NODE_ENV=production
# Event logs of real runs. Ephemeral here; point it at a volume to keep them.
ENV REMATCH_ARTIFACT_DIR=/tmp/rematch-artifacts
RUN mkdir -p /tmp/rematch-artifacts

EXPOSE 8080
WORKDIR /app/packages/server
# Same flags as `pnpm start`, minus the .env file: secrets come from the host.
CMD ["node", "--experimental-strip-types", "src/main.ts"]
