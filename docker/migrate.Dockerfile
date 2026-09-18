# syntax=docker/dockerfile:1.7
# One-shot schema runner: applies drizzle migrations + _post/*.sql, then exits.
#
# WHY THIS IMAGE EXISTS. There was no migration step anywhere in
# docker-compose.yml, so a first boot came up against an empty database -- the
# health endpoint reported `migrations: {applied: 0, expected: 22}` and every
# authenticated page threw (docs/verification.md B13).
#
# scripts/deploy.sh tried to cover this with
#   docker compose exec app pnpm --filter @gml/db migrate
# which cannot work: the app image is a Next.js standalone build containing no
# pnpm, no tsx and no packages/db. A purpose-built image is the fix -- a schema
# change must not depend on the web container's contents.

ARG NODE_VERSION=22-slim

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json     packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json     packages/ui/
COPY apps/web/package.json        apps/web/
COPY apps/worker/package.json     apps/worker/
RUN pnpm install --frozen-lockfile --filter @gml/db...

FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production

# Source first, then the Linux dependency trees on top -- same ordering fix as
# docker/app.Dockerfile, so a stray host node_modules can never shadow them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db  ./packages/db
COPY --from=deps /repo/node_modules             ./node_modules
COPY --from=deps /repo/packages/db/node_modules ./packages/db/node_modules

# The migration runner reads packages/db/src/migrations/**.sql and
# meta/_journal.json from disk, so those must be real files in the image --
# this is why .dockerignore deliberately does NOT exclude them.
WORKDIR /repo/packages/db

# Idempotent by design: drizzle records applied migrations in its journal table
# and scripts/migrate.ts tracks _post/*.sql in _post_migrations_applied, so
# re-running on every deploy is a no-op once the schema is current.
CMD ["pnpm", "exec", "tsx", "scripts/migrate.ts"]
