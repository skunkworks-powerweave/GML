# GML LMS

Production-grade Learning Management System for Goldenmile Learning's RTT (Refresher Teacher Training) programme in Ladakh-UT.

- **Plan:** [`../PLAN.md`](../PLAN.md)
- **Progress ledger:** [`../PROGRESS.md`](../PROGRESS.md)
- **IT deploy guide:** [`README-IT.md`](README-IT.md)
- **Project context for Claude Code:** [`CLAUDE.md`](CLAUDE.md)

## Stack

Next.js 15 (App Router) + TypeScript + Tailwind + shadcn · PostgreSQL 16 · Drizzle ORM · Auth.js v5 · Redis + BullMQ · MinIO (S3-compatible) · tusd (resumable uploads) · ffmpeg worker · Caddy 2 (auto-TLS).

Single `docker-compose up -d` deploys the entire stack on a Linux VPS against a domain name.

## Getting started (developer)

```powershell
# Install pnpm 10 if you haven't:
npm install -g pnpm@10

# From this folder:
pnpm install
pnpm --filter @gml/web dev          # http://localhost:3000
```

For the full stack (Postgres, Redis, MinIO, etc.), see [`README-IT.md`](README-IT.md) — but the docker-compose stack lands in spec 002.

## Status

Spec 001 (harness scaffold) in progress. See [`../PROGRESS.md`](../PROGRESS.md) for the ledger and [`specs/`](specs/) for the spec-kit.

## License

Internal use only — Goldenmile Learning.
