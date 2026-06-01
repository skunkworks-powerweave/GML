# Spec 104 — Form Catalog Seed Runner (Workflow Run 6 Tier B2)

## Why

The deployment audit surfaced that a fresh GML LMS deployment needed five
manual `pnpm exec tsx …` invocations to populate seed data — `seed.ts` for
districts/schools/teachers/cycles/super_admin, then four separate
form-catalog scripts for mentor / mentee / observation / misc feedback
templates. Five hand-typed commands, no single document tying them
together, and no enforced ordering means an operator can easily miss one
(e.g. forget the observation form seed, then watch the first cycle render
break because `OBS-2026-001` has no templates). The README-IT had to spell
out the sequence in prose, which is exactly the kind of operational tax
that shows up as a 2 AM Slack message six months in.

## What

A single in-process orchestrator script — `packages/db/src/scripts/seed_all.ts`
— that runs all five seeds in dependency order against the same
`DATABASE_URL`, with per-phase timing, fail-fast semantics, and an exposed
pnpm command `pnpm --filter @gml/db run seed:all`. The orchestrator imports
each sub-script's `main()` function directly (no `spawnSync` ceremony, no
duplicated dotenv loading, no separate pg.Pool per phase from the
orchestrator's perspective — each sub-script still owns its own pool). The
five sub-scripts are refactored from `async function main()` to
`export async function main()` and the bottom-of-file auto-runner is gated
by an `import.meta.url === pathToFileURL(process.argv[1]).href` check, so:

- direct invocation (`tsx seed_forms_mentor.ts`) keeps working unchanged,
- importing the module (as the orchestrator now does) does NOT auto-run,
- and ordering is guaranteed because phases run sequentially with `await`.

## Phase order and dependencies

1. **`seed`** runs first. It creates districts, zones, schools, teachers,
   mentors, pairings, observation cycles (including the canonical
   `OBS-2026-001`), curriculum subjects, RTT phases / terms / RTT
   subjects, and bootstraps the `super_admin` user (spec 103). The
   observation-form seed below references `OBS-2026-001` by code, so this
   must complete first.

2. **`seed_forms_mentor`** inserts 4 mentor-audience feedback-form
   templates (baseline / progress_1 / progress_2 / final).

3. **`seed_forms_mentee`** inserts 4 mentee-audience feedback-form
   templates with the same kind/audience/version unique-key idempotency.

4. **`seed_forms_observation`** inserts 3 observation templates (pre, post,
   observer) onto `OBS-2026-001` — depends on phase 1 having created that
   cycle.

5. **`seed_forms_misc`** inserts the school-visit and endline feedback
   forms, keyed by `version` (since `feedbackKindEnum` lacks
   `schoolvisit` / `endline` values — see spec 078's design deviation).

## Failure semantics

Fail fast. If any phase throws, the orchestrator logs which phase failed
with elapsed time, and exits 1. Earlier phases' writes are NOT rolled back
(each sub-script's idempotency means re-running picks up where we left
off). This matches the operator mental model: "if seed:all fails, fix the
underlying issue, then re-run seed:all — completed phases will skip
because of their existence checks."

## Logging contract

- `[seed:all] starting N phases (DRY_RUN=…)` at the top.
- `[seed:all] → phase: <name>` before each phase.
- `[seed:all] ✓ phase '<name>' done in X.XXs` on success.
- `[seed:all] ✗ phase '<name>' failed after X.XXs:` on failure (then exit 1).
- `[seed:all] DONE — N phases in X.XXs` at the bottom on overall success.

## Non-goals

- No new feedback-form templates here. All template content already exists
  in specs 075–078; this spec is pure plumbing.
- No transaction wrapping across phases. Each sub-script manages its own
  pool and the idempotency guards make a wrapper transaction unnecessary
  (and would conflict with the per-script pool lifecycle anyway).
- No schema migration. The five scripts already exist and are unchanged
  apart from the `export` keyword + the entry-point guard.
- No new dependencies. We add a single `import { pathToFileURL } from
  "node:url"` to each script, which is a Node built-in.

## Definition of done

- `pnpm --filter @gml/db run seed:all` against a fresh DB inserts every
  row that the five scripts would individually insert.
- Re-running on a populated DB is a no-op (every phase logs
  "already exist — skipping" or equivalent).
- Direct invocation of any sub-script (e.g. `pnpm exec tsx
  src/scripts/seed_forms_mentor.ts`) still works unchanged.
- Governance test `test_104_form_catalog_seed_runner.test.mjs` asserts
  the orchestrator exists, references all 5 sub-scripts, exports a
  `main()` from each, and is wired into `package.json`.
