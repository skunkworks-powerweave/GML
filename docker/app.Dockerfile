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
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY . .
WORKDIR /repo/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --spider --quiet http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "apps/web/server.js"]
