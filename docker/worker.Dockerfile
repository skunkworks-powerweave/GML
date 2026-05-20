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

# Real entrypoint lands in spec 024. For spec 002 we want the container to start
# successfully and stay running so `docker compose up -d` reports it as up.
CMD ["node", "-e", "console.log('worker idle — real consumer lands in spec 024'); setInterval(() => {}, 1<<30);"]
