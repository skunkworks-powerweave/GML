# Tasks 001 — Harness Scaffold

TDD-ordered. Each numbered task has a verification step.

## T1 — Write the governance test FIRST (red phase)

- [ ] Create `tests/governance/test_001_harness_scaffold.test.ts` asserting:
  - root `package.json` parses; has `workspaces` array including `apps/*` and `packages/*`
  - root `package.json` has `packageManager: "pnpm@10.33.4"` (or compatible)
  - `pnpm-workspace.yaml` exists
  - `workspace/state.json` parses to JSON with `currentSpec === "001"`
  - `.claude/settings.json` parses; contains hook entries for `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`
  - All these files exist: `README.md`, `README-IT.md`, `CLAUDE.md`, `.gitignore`, `.env.example`, `docs/substrate-moats.md`, `docs/verification.md`, `docs/architecture.md`, `docs/operations.md`
  - `apps/web/package.json` parses and has `name: "@gml/web"`
  - `apps/worker/package.json` parses
  - `packages/db/package.json`, `packages/ui/package.json`, `packages/shared/package.json` all parse
- **Verify red:** `pnpm test` fails with multiple ENOENT / parse errors. Capture failure count for the ledger.

## T2 — Root workspace files (green phase begins)

- [ ] Create root `package.json` (`name: "gml-lms"`, `private: true`, `workspaces: ["apps/*","packages/*"]`, `packageManager: "pnpm@10.33.4"`, `scripts: { test: "node --test 'tests/**/*.test.ts'", "dev": "pnpm --filter @gml/web dev" }`)
- [ ] Create `pnpm-workspace.yaml` (`packages: ['apps/*','packages/*']`)
- [ ] Create `.gitignore`
- [ ] Create `.env.example`
- [ ] Create `README.md`
- [ ] Create `README-IT.md` (placeholder; real content in spec 069)
- [ ] Create `CLAUDE.md`

## T3 — Empty workspace members

- [ ] `packages/db/package.json` — `{ "name": "@gml/db", "version": "0.0.0", "private": true }`
- [ ] `packages/ui/package.json` — `{ "name": "@gml/ui", "version": "0.0.0", "private": true }`
- [ ] `packages/shared/package.json` — `{ "name": "@gml/shared", "version": "0.0.0", "private": true }`
- [ ] `apps/worker/package.json` — `{ "name": "@gml/worker", "version": "0.0.0", "private": true }`

## T4 — Next.js scaffolding for `apps/web`

- [ ] `pnpm create next-app apps/web --ts --tailwind --app --eslint --src-dir --import-alias '@/*' --use-pnpm`
- [ ] Edit `apps/web/package.json` → rename `name` to `@gml/web`

## T5 — Hook scripts (stubs, exit 0)

- [ ] `scripts/session_start.mjs` — reads `workspace/state.json`, parses PROGRESS.md for completed-count, prints one summary line
- [ ] `scripts/stop_session.mjs` — appends to `workspace/session_log.md`
- [ ] `scripts/block_destructive.mjs` — pattern-matches `rm -rf`, `DROP TABLE`, `docker compose down -v` against `$TOOL_INPUT`, exits 2 with reason on match, 0 otherwise
- [ ] `scripts/warn_schema_change.mjs` — prints a reminder, exits 0
- [ ] `scripts/warn_middleware_change.mjs` — prints a reminder, exits 0
- [ ] `scripts/check_migration_reversible.mjs` — prints a reminder, exits 0

## T6 — `.claude/settings.json`

- [ ] Wire the 6 hooks exactly per PLAN.md § "Hooks":
  - `SessionStart` → `node scripts/session_start.mjs`
  - `PreToolUse Bash` → `node scripts/block_destructive.mjs "$TOOL_INPUT"`
  - `PreToolUse Edit|Write` on `packages/db/src/schema/**` → `node scripts/warn_schema_change.mjs "$TOOL_INPUT"`
  - `PreToolUse Edit|Write` on `apps/web/src/middleware.ts` → `node scripts/warn_middleware_change.mjs "$TOOL_INPUT"`
  - `PostToolUse Edit|Write` on `apps/web/src/db/migrations/**` → `node scripts/check_migration_reversible.mjs "$TOOL_INPUT"`
  - `Stop` → `node scripts/stop_session.mjs`

## T7 — `workspace/` runtime files

- [ ] `workspace/state.json` — `{"currentSpec":"001","currentPhase":0,"specsCompleted":0,"specsTotal":70}`
- [ ] `workspace/session_log.md` — header only
- [ ] `workspace/marathon_log.md` — header only

## T8 — `docs/` placeholders

- [ ] `docs/substrate-moats.md` — H1 + "TBD — populated in spec 011"
- [ ] `docs/verification.md` — H1 + "TBD — grows spec-by-spec"
- [ ] `docs/architecture.md` — H1 + link to PLAN.md § Architecture
- [ ] `docs/operations.md` — H1 + "TBD — populated in spec 067"

## T9 — `pnpm install`

- [ ] Run from `lms-app/`. Expect: completes without errors. node_modules gets created. lockfile `pnpm-lock.yaml` appears.

## T10 — Green phase verification

- [ ] Re-run `pnpm test` → all assertions in T1 now pass.
- [ ] `node scripts/session_start.mjs` → prints one summary line, exit 0.
- [ ] `pnpm --filter @gml/web dev` → starts Next.js on :3000 (manual smoke; Ctrl-C to stop).
- [ ] `git init` inside `lms-app/` (no commit yet).

## T11 — Append PROGRESS.md ledger entry

- [ ] Open `C:\Users\himan\OneDrive\Desktop\GML\PROGRESS.md`
- [ ] Append the `## YYYY-MM-DD — Spec 001: harness-scaffold — COMPLETE` block per the template
- [ ] Update the status board counts (Phase 0: done 1, todo 2; total done 1)
- [ ] Check off `001-harness-scaffold` in the catalog list
- [ ] Update `workspace/state.json` → `currentSpec: "002", specsCompleted: 1`

## T12 — Self-review

- [ ] Re-read this `tasks.md` top to bottom. Anything skipped? Anything broken?
- [ ] Invoke `feature-dev:code-reviewer` on the full diff. Resolve any high-priority findings.
