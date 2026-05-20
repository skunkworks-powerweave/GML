# Plan 001 — Harness Scaffold

**Spec:** `specs/001-harness-scaffold/spec.md`
**Date:** 2026-05-20
**Constitution Check:** PASS (no substrate moats touched — scaffolding only)

## Implementation Blueprint

### Phase 2 — Foundational (folder layout + workspace config)

Files CREATED:
- [P] `package.json` — root workspace manifest (`name: gml-lms`, `private: true`, `workspaces: ["apps/*", "packages/*"]`, `packageManager: "pnpm@10.33.4"`)
- [P] `pnpm-workspace.yaml` — explicit pnpm workspace declaration
- [P] `.gitignore` — node_modules, .next, .docker-volumes, workspace/, *.local.*, .env, dist, *.log
- [P] `.env.example` — placeholder env vars: DOMAIN, POSTGRES_PASSWORD, AUTH_SECRET, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, WHATSAPP_*, SMTP_*, SUPER_ADMIN_EMAIL, SUPER_ADMIN_INITIAL_PASSWORD
- [P] `README.md` — top-level overview pointing at PLAN.md + PROGRESS.md + specs/
- [P] `README-IT.md` — 1-page placeholder for IT (real content lands in spec 069)
- [P] `CLAUDE.md` — project context document (Project / Plan + Ledger / Specs / Harness / Hooks / Folder map)
- [P] `packages/db/package.json`, `packages/ui/package.json`, `packages/shared/package.json` — stub workspace members
- [P] `apps/worker/package.json` — stub worker package (real entry in spec 024)
- [P] `docs/substrate-moats.md`, `docs/verification.md`, `docs/architecture.md`, `docs/operations.md` — empty placeholders with H1 + "TBD" note

### Phase 3 — Integration (Next.js app + hooks + workspace runtime)

Files CREATED:
- `apps/web/` — via `pnpm create next-app apps/web --typescript --tailwind --app --no-eslint --no-src-dir --import-alias '@/*' --use-pnpm` (renames to `@gml/web` after generation by editing `apps/web/package.json`)
- `.claude/settings.json` — 6 hooks (SessionStart, PreToolUse Bash, PreToolUse Edit|Write on schema/**, PreToolUse Edit|Write on middleware.ts, PostToolUse Edit|Write on migrations/**, Stop) wired to scripts under `scripts/`
- `scripts/session_start.mjs` — reads `workspace/state.json` + `PROGRESS.md`, prints `Spec NNN — X/70 complete (current: <slug>)` line
- `scripts/block_destructive.mjs` — PreToolUse Bash hook stub; recognises rm -rf, DROP TABLE, docker compose down -v; exits 2 with message on match, 0 otherwise
- `scripts/warn_schema_change.mjs` — PreToolUse Edit|Write stub on `packages/db/src/schema/**`; prints a reminder, exits 0
- `scripts/warn_middleware_change.mjs` — PreToolUse Edit|Write stub on middleware.ts; prints a reminder, exits 0
- `scripts/check_migration_reversible.mjs` — PostToolUse stub for migrations/**; exits 0 with a print for now
- `scripts/stop_session.mjs` — Stop hook; appends a one-line session summary to `workspace/session_log.md`
- `workspace/state.json` — initial state `{currentSpec: "001", currentPhase: 0, specsCompleted: 0, specsTotal: 70}`
- `workspace/session_log.md` — header line only
- `workspace/marathon_log.md` — header line only

### Phase 4 — Test coverage

Files CREATED:
- `tests/governance/test_001_harness_scaffold.test.ts` — uses Node's built-in `node:test` runner (no test framework needed yet) to assert:
  - `package.json` parses; has `workspaces` array containing both `apps/*` and `packages/*`
  - `workspace/state.json` parses to `{currentSpec: "001", ...}`
  - `.claude/settings.json` parses; contains the 6 expected hook entries
  - All listed placeholder files exist (`README.md`, `README-IT.md`, `CLAUDE.md`, `docs/substrate-moats.md`, etc.)
- Test runner registered in root `package.json` scripts: `"test": "node --test tests/**/*.test.ts"`

### Phase 5 — git init (no commit yet)

- Run `git init` inside `lms-app/`
- Verify `.gitignore` is recognised (`git status` shows none of the ignored paths)
- **Do NOT commit yet** — spec 002 ships docker-compose and the first commit covers both

## Data flow

```
PROGRESS.md (GML root)  ←─ this spec appends a ledger entry on completion
        │
        ▼
lms-app/workspace/state.json  ←─ session_start.mjs reads
        │
        ▼
SessionStart hook → prints one-line summary to terminal

User edits files
        │
        ▼
PreToolUse hooks (Bash, schema, middleware) → block or warn
        │
        ▼
PostToolUse hooks (migrations) → verify
        │
        ▼
Stop hook → appends to session_log.md
```

## Corrections applied

(None — this is the first spec.)
