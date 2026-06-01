# syntax=docker/dockerfile:1.7
# Worker image — Node 22 + ffmpeg for video transcoding jobs (spec 024+).

ARG NODE_VERSION=22-slim

FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --filter @gml/worker... --filter @gml/worker

FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1002 worker \
 && useradd  --system --uid 1002 --gid worker worker

COPY --from=deps --chown=worker:worker /repo /app

USER worker

# Spec 100 (Workflow Run 6, Tier A1) — real BullMQ consumer entrypoint.
# Invokes the @gml/worker package's `start` script which runs `tsx src/index.ts`.
# tsx + ioredis + bullmq are installed via `pnpm install --frozen-lockfile` in the
# deps stage above, so no additional install is needed at runtime. The worker
# connects to REDIS_URL, drains the `transcode` queue, and shells out to the
# `ffmpeg` apt package installed in this image's deps + runner stages.
WORKDIR /app/apps/worker
CMD ["pnpm", "--filter", "@gml/worker", "exec", "tsx", "src/index.ts"]
