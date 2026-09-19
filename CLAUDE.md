# GML LMS — Project Context for Claude Code

## Project

Custom LMS for Goldenmile Learning's RTT (Refresher Teacher Training) programme in Ladakh-UT. Low-bandwidth-aware, Postgres-backed, self-hostable via single `docker compose up -d`. Internal use only — never SaaS.

Three core surfaces: **Classroom Observation** (baseline / developmental / evaluative), **RTT Phases 1-3** (district → zone → term → subject), **Mentorship** (~150 meeting recordings + Q1/Q4 mentee videos).

Hard requirements: Postgres backend; section-level rotatable passwords; audit log; two video paths (direct upload + WhatsApp Business webhook); admin-editable no-code tables; mobile-friendly.

## Plan + Ledger

- **Plan** (authoritative): [`../PLAN.md`](../PLAN.md) (canonical at `C:\Users\himan\.claude\plans\c-users-himan-onedrive-desktop-gml-clas-noble-eagle.md`)
- **Append-only ledger**: [`../PROGRESS.md`](../PROGRESS.md). Spec is only CLOSED when its ledger entry exists.
- **Status board**: at the top of `PROGRESS.md`.

## Specs (spec-kit)

Every feature is a numbered folder at [`specs/NNN-<slug>/`](specs/) with 5 files: `spec.md`, `plan.md`, `research.md`, `quickstart.md`, `tasks.md`, plus `contracts/` for API contracts.

153 specs exist on disk; the grouping below describes the original 70-spec plan and is kept for orientation:
- Phase 0 (001-003) — scaffolding
- Phase 1 (004-011) — auth, RBAC, section gates, audit
- Phase 2 (012-021) — admin no-code tables (marathon candidate)
- Phase 3 (022-031) — video pipeline (direct + WhatsApp)
- Phase 4 (032-046) — three core pages (marathon candidate for subject pages)
- Phase 5 (047-056) — forms, quizzes, feedback (marathon candidate for form catalog)
- Phase 6 (057-061) — SCORM, i18n, seed data
- Phase 7 (062-070) — hardening

## Harness

Pattern reused from `C:\Users\himan\OneDrive\Desktop\Base Version`:
1. **Spec-kit** — 5 files per feature (see Specs above)
2. **Superpowers discipline** — `brainstorming → writing-plans → test-driven-development → verification-before-completion → requesting-code-review → finishing-a-development-branch` for every spec
3. **Ralph loop** — `/loop` for marathon batches (admin tables, form catalog)
4. **Append-only ledger** — `PROGRESS.md`, format mirrors Base Version's `PHASE_G_PROGRESS.md`
5. **Hooks** — `.claude/settings.json`, 6 hooks (see Hooks below)
6. **Substrate moats** — SM-1..SM-9 invariants defended at multiple layers. Defined in [`docs/substrate-moats.md`](docs/substrate-moats.md) (SM-7/8/9 were cited in ~40 source files and defined nowhere until that doc was written).

## Hooks

Configured in [`.claude/settings.json`](.claude/settings.json):

| Hook                                     | Script                                          | Purpose |
|------------------------------------------|------------------------------------------------|---------|
| SessionStart                             | `scripts/session_start.mjs`                    | Print progress summary |
| PreToolUse Bash                          | `scripts/block_destructive.mjs`                | Block `rm -rf`, `DROP TABLE`, `docker compose down -v` |
| PreToolUse Edit/Write on `schema/**`     | `scripts/warn_schema_change.mjs`               | Remind to write migration |
| PreToolUse Edit/Write on `middleware.ts` | `scripts/warn_middleware_change.mjs`           | Remind that auth changes need a spec. NOTE: Next 16 renamed the convention to `proxy.ts`, so this hook no longer fires on the file it was written for. |
| PostToolUse Edit/Write on `migrations/**`| `scripts/check_migration_reversible.mjs`       | Verify reversibility |
| Stop                                     | `scripts/stop_session.mjs`                     | Append session summary to `workspace/session_log.md` |

## Folder map

```
lms-app/
├── apps/web/             ← Next.js 16
├── apps/worker/          ← ffmpeg + Postgres-queue consumer
├── packages/db/          ← Drizzle schema, migrations, job queue
├── packages/ui/          ← shadcn re-exports
├── packages/shared/      ← zod schemas, utils, types
├── specs/                ← one folder per spec
├── workspace/            ← runtime state (gitignored)
├── .claude/settings.json ← hooks
├── scripts/              ← hook scripts + ship.ps1 + backup.sh
├── docker/               ← Dockerfiles + Caddyfile
├── docs/                 ← architecture / verification / operations / substrate-moats
└── tests/governance/     ← substrate-moat regression tests
```

## Current state (read this before trusting anything above)

The sections above describe the harness and the original plan. What is actually
deployed differs in ways worth knowing:

- **Auth is Supabase**, not Auth.js. `auth()` keeps its old signature; the
  implementation behind it changed completely. See `docs/architecture.md`.
- **There is no local Postgres, Redis, MinIO or tusd.** Four containers:
  `caddy`, `app`, `worker`, `migrate`.
- **`middleware.ts` is `proxy.ts`** (Next 16 renamed the convention; proxy runs
  on the Node runtime and that is not configurable).
- **Tests are in three tiers and they are NOT interchangeable.**
  `tests/governance/` regex-matches source text and cannot observe a runtime
  behaviour — it was green for months while the app could not boot.
  `tests/behaviour/` executes real code against a real Postgres.
  `tests/integration/` drives a running deployment.

## Locked-in decisions (do not re-litigate without explicit sign-off)

1. Postgres (not MariaDB / MySQL / MongoDB) — non-negotiable.
2. Custom build (not Frappe / CourseLit / Open edX / Canvas) — see [`../PLAN.md` § "LMS base evaluation"](../PLAN.md).
3. WhatsApp Business Cloud API is the **primary** low-bandwidth video path.
4. Hosting: single AWS EC2 instance running `docker compose`, with Supabase for Postgres/Auth/Storage. (Superseded the original 'Cloud VPS' decision when MinIO withdrew their public Docker images and the self-hosted stack became unbootable.)
5. v1 scope is FULL: quizzes, SCORM, seed data, en/hi/bo i18n.
6. Internal use only — AGPL is not a concern.

## Reference repos (clones at `C:\Users\himan\OneDrive\Desktop\Repos\`)

- `frappe-lms` — borrow DocType-style admin patterns; do NOT use as base (MariaDB-locked)
- `courselit` — borrow shadcn admin shell + dual app+queue split; do NOT use as base (Mongoose-locked)
- `canvas-lms` — borrow `enrollments`/`submissions`/`gradebook_csv_export` schema patterns; do NOT use as base (Rails + 8GB-dev-floor)
- `edx-platform` — borrow nothing major; ruled out (MySQL-only)
