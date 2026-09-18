# syntax=docker/dockerfile:1.7
# Worker image — Node 22 + ffmpeg. Consumes the transcode queue and runs the
# nightly retention job.
#
# WHAT WAS WRONG. This Dockerfile contained no COPY of application source at
# ALL. It copied the five package.json manifests, ran pnpm install, and then
# `COPY --from=deps /repo /app` — so the image held node_modules and manifests
# and nothing else. /app/apps/worker/src/index.ts did not exist. With
# `restart: unless-stopped` and no healthcheck on the service, the container
# crash-looped silently forever and NO video was ever transcoded.
#
# `corepack enable` also ran only in the deps stage, so `pnpm` was not on PATH
# in the runner — the CMD could not have started even with the source present.
#
# Both are fixed below. A CI job (.github/workflows/test.yml -> "container
# images") now builds this image and asserts the entrypoint file exists inside
# it, because a Dockerfile can only be verified by building it.

ARG NODE_VERSION=22-slim

# ── base: corepack in EVERY stage that needs pnpm, including the runner ────────
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# ── deps: install only what @gml/worker needs ─────────────────────────────────
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json     apps/worker/package.json
COPY apps/web/package.json        apps/web/package.json
COPY packages/db/package.json     packages/db/package.json
COPY packages/ui/package.json     packages/ui/package.json
COPY packages/shared/package.json packages/shared/package.json
# `@gml/worker...` already includes @gml/worker itself; the old duplicate
# `--filter @gml/worker` was redundant.
RUN pnpm install --frozen-lockfile --filter @gml/worker...

# ── runner ────────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production

# ffmpeg is the whole point of this image. ca-certificates is needed for TLS to
# Postgres and object storage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1002 worker \
 && useradd  --system --uid 1002 --gid worker worker

# THE MISSING PIECE: the source. Copied FIRST, then the Linux dependency trees
# on top — same ordering as docker/app.Dockerfile, so a stray host node_modules
# can never shadow the correctly-installed ones.
COPY --chown=worker:worker package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=worker:worker apps/worker   ./apps/worker
COPY --chown=worker:worker packages/db   ./packages/db
COPY --chown=worker:worker packages/shared ./packages/shared

COPY --from=deps --chown=worker:worker /repo/node_modules                 ./node_modules
COPY --from=deps --chown=worker:worker /repo/apps/worker/node_modules     ./apps/worker/node_modules
COPY --from=deps --chown=worker:worker /repo/packages/db/node_modules     ./packages/db/node_modules

USER worker
WORKDIR /repo/apps/worker

# Invoke tsx DIRECTLY rather than shelling through `pnpm exec`.
#
# `pnpm exec ...` re-enters corepack at runtime, and corepack then tries to
# download the pinned pnpm into $HOME/.cache/node/corepack. The container runs
# as the unprivileged `worker` user, whose home is not writable, so the very
# first thing the container did was:
#
#     Error: EACCES: permission denied, mkdir '/home/worker/.cache/node/corepack/v1'
#
# i.e. even once the missing source was restored, the image still crash-looped —
# just on a different error. Found by actually running the container. Calling
# the resolved bin skips corepack entirely and removes a network dependency
# from process start.
#
# tsx is a devDependency being used at runtime, which is not ideal. Compiling to
# dist/ with esbuild would drop it from the production image and make
# `typecheck` a build-time gate; that is a deliberate follow-up, kept separate
# from fixing the image being empty.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
