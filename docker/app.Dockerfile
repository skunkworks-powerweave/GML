# syntax=docker/dockerfile:1.7
# Multi-stage build for the Next.js app (apps/web).
# Stages: deps → builder → runner. Runner image is ~120 MB.

ARG NODE_VERSION=22-slim

# ── deps ───────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# Copy workspace manifests first to exploit Docker layer cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --filter @gml/web... --filter @gml/web

# ── builder ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# Source FIRST, then the Linux node_modules ON TOP.
#
# The original order was reversed (`COPY --from=deps ... node_modules` then
# `COPY . .`), which meant the host's node_modules overwrote the correctly
# installed Linux tree. That went unnoticed only because .dockerignore sat in
# docker/ where Docker never reads it, so the host tree was being shipped in
# and happened to satisfy the imports.
#
# It also copied just two of the five workspace node_modules trees. With the
# ignore file fixed, `next build` fails on `@gml/db` / `@gml/shared` imports:
# pnpm links workspace packages by symlink, so packages/db's OWN dependencies
# (drizzle-orm, pg) must be present at packages/db/node_modules. On a clean
# checkout -- which is what CI and the IT team have -- there is no host tree to
# paper over this, so the app image has never actually built from a fresh clone.
COPY . .
COPY --from=deps /repo/node_modules               ./node_modules
COPY --from=deps /repo/apps/web/node_modules      ./apps/web/node_modules
COPY --from=deps /repo/packages/db/node_modules   ./packages/db/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
# apps/web declares a workspace dependency on @gml/worker (for transcodeQueue),
# which is why bullmq and ioredis are in the web dependency graph at all. This
# line goes away with that dependency when the queue moves to Postgres.
COPY --from=deps /repo/apps/worker/node_modules   ./apps/worker/node_modules

WORKDIR /repo/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# packages/db/src/client.ts constructs a pg Pool at import time; give it a URL
# it will never dial so the build cannot fail on a missing env var.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
RUN pnpm exec next build

# ── runner ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /repo/apps/web/public ./public
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000

# node:22-slim ships neither wget nor curl -- the previous `wget --spider`
# check failed with "wget: not found" on every probe, so the container was
# permanently `unhealthy` (verified: docs/verification.md B14). `node` is the
# only usable binary in this image, and its global fetch() is enough.
# /api/health now returns a non-2xx status when a dependency is down, so
# r.ok is a real signal rather than a formality.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
