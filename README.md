# GML LMS

Learning Management System for Goldenmile Learning's RTT (Refresher Teacher
Training) programme in Ladakh-UT. Internal use only.

Three core surfaces: **Classroom Observation**, **RTT Phases 1–3**, and
**Mentorship**. Two video ingest paths: direct browser upload, and WhatsApp
Business — the latter being the primary one, because a teacher in a Ladakh
classroom has WhatsApp and may not have anything else.

RTT subjects can also carry **SCORM 1.2** modules: uploaded by a super_admin,
launched from the subject page, tracked per learner. See
[`docs/operations.md` § SCORM packages](docs/operations.md#scorm-packages).

| | |
|---|---|
| Deploying it | [`README-deploy.md`](README-deploy.md) |
| Running it day to day | [`docs/operations.md`](docs/operations.md) |
| Invariants it defends | [`docs/substrate-moats.md`](docs/substrate-moats.md) |
| How it is put together | [`docs/architecture.md`](docs/architecture.md) |
| What has actually been observed working | [`docs/verification.md`](docs/verification.md) |
| Context for Claude Code | [`CLAUDE.md`](CLAUDE.md) |

## Stack

Next.js 16 (App Router) · TypeScript · Drizzle ORM · **Supabase** (Postgres,
Auth, Storage) · ffmpeg worker · Caddy 2 (auto-TLS).

Four containers on one host: `caddy`, `app`, `worker`, and a one-shot `migrate`
that gates the other two. Everything stateful is in Supabase.

**Video bytes never pass through the application server.** Uploads go
browser → Supabase Storage directly over TUS; playback segments are fetched by
the browser from Supabase's CDN using signed URLs embedded in the playlist the
app generates. That is why a 2-vCPU instance is enough for a video product.

## Getting started (developer)

```bash
pnpm install
cp .env.example .env     # fill in the Supabase section
pnpm --filter @gml/db migrate
pnpm --filter @gml/web dev          # http://localhost:3000
```

There is no local Postgres, Redis or MinIO to run. Point `DATABASE_URL` and the
Supabase keys at a project — a free one is fine for development.

## Tests

```bash
pnpm test              # governance: structural invariants, source-text assertions
pnpm test:behaviour    # behavioural: executes real code against a real Postgres
pnpm test:smoke        # post-deploy: drives a RUNNING deployment over HTTP
```

**These are not interchangeable, and the distinction matters.** `pnpm test`
reads source files and regex-matches their text. Not one of its ~1500
assertions can observe a runtime behaviour, and for a long time that suite
reported green while the section gate compared a cookie to the string `"1"`,
every video segment 403'd, the worker container shipped without its own source
code, and `docker compose up` could not start on any machine.

It still has a job — it pins structural things a runtime test cannot reach — but
it is not evidence that anything works. `pnpm test:behaviour` is.

## Status

Deployed against Supabase. See [`docs/verification.md`](docs/verification.md)
for what has been observed working and what has not, and
[`../PROGRESS.md`](../PROGRESS.md) for the ledger.

## License

Internal use only — Goldenmile Learning.
