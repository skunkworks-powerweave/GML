# Spec 077 — Observation form catalog seed (pre / post / observer)

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 8 (Forms & quizzes)

## Overview

Seeds the three canonical observation form **templates** — `pre` (teacher self-prep
before the lesson), `post` (teacher reflection after the lesson), and `observer`
(the rubric the observer fills in while watching). The seed is delivered as a
TypeScript script runnable via `tsx` at `packages/db/src/scripts/seed_forms_observation.ts`
and is idempotent: it can be re-run safely after spec 086 (`seed.ts`) has
populated the eight `observation_cycles` rows.

Catalog shape — same idea as `feedback_forms.schema` (a jsonb `fields` array
with prompts, types, and rubric scales) — but the schema is locked and there
is no separate `observation_form_templates` table. The brief explicitly directs
us to use `observation_forms` (NOT `feedback_forms` — different table). We
therefore route the three templates through `observation_forms` itself by
attaching them to the **canonical seed cycle** (`code = 'OBS-2026-001'`,
created by spec 086) and writing the field definitions into the existing
`responses` jsonb column under a top-level `fields` key. The `(cycleId, kind)`
unique index makes the three rows naturally idempotent on re-run. The form
UI in spec 074 / 075 reads its template by fetching the lone row whose
`cycle.code = 'OBS-2026-001'` and `kind = '<pre|post|observer>'`. The deviation
is documented in `designDeviations` and `research.md`.

## Functional Requirements

- **FR-001**: Script lives at `packages/db/src/scripts/seed_forms_observation.ts`
  and is invoked via `pnpm --filter @gml/db exec tsx src/scripts/seed_forms_observation.ts`.
- **FR-002**: Connects to `process.env.DATABASE_URL` using `pg.Pool` +
  `drizzle-orm/node-postgres`, exactly mirroring `packages/db/src/scripts/seed.ts`
  for consistency (no new dependencies).
- **FR-003**: Loads `dotenv/config` at the top so a checked-in `.env` works
  identically to `seed.ts` and `retention.ts`.
- **FR-004**: Exits cleanly with code 1 if `DATABASE_URL` is unset, printing
  a single helpful line — matches `seed.ts` exit semantics.
- **FR-005**: Supports `SEED_DRY_RUN=true` — when set, the script prints what
  it WOULD insert and exits without touching the database. Matches `seed.ts`.
- **FR-006**: Looks up the canonical seed cycle by code `OBS-2026-001`. If
  the row is missing, prints a friendly error directing the operator to run
  `pnpm --filter @gml/db run seed` first, and exits 1 (non-fatal at the seed
  level — the unique-violation path would hide the real problem).
- **FR-007**: Inserts three rows into `observation_forms` for the canonical
  cycle — one per `kind` of `pre`, `post`, `observer`. Each row's `responses`
  jsonb carries a `{ fields: [...] }` template that the form-rendering UI
  walks at render time.
- **FR-008**: Idempotent — uses `INSERT ... ON CONFLICT (cycle_id, kind) DO
  NOTHING` (via Drizzle's `.onConflictDoNothing()`) so re-runs are safe.
  The unique index `observation_forms_cycle_kind_uq` already exists.
- **FR-009**: `pre` template fields (teacher self-prep): `lessonPlanSummary`
  (textarea, required), `learningOutcomes` (multiline text list, required —
  one outcome per line), `anticipatedDifficulties` (textarea, optional).
  Every field has `key`, `label`, `type`, `required`, and (where applicable)
  `placeholder` properties.
- **FR-010**: `post` template fields (teacher reflection): `whatWorked`
  (textarea, required), `whatDidNot` (textarea, required), `surpriseMoments`
  (textarea, optional), `nextTime` (textarea, required).
- **FR-011**: `observer` template fields (rubric): five 1–5 scales —
  `lessonStructure`, `studentEngagement`, `teacherQuestioning`,
  `classroomManagement`, `languageUse` — each with type `scale`, min `1`,
  max `5`, and the rubric anchor labels in `anchors` (a 5-element string
  array). Plus a `narrativeComments` textarea (required).
- **FR-012**: `schemaVersion` set to `"1"` on each row (matches the column
  default; written explicitly for clarity).
- **FR-013**: `submittedAt` set to `now()` and `submittedByUserId` left
  `null` — the templates are seed-owned, not user-owned. (Column is
  nullable; FK is ON DELETE SET NULL.)
- **FR-014**: Prints a single summary line on success — number of inserted
  rows, number of skipped (already present) rows, total.
- **FR-015**: Top-level error handler mirrors `seed.ts`: `main().catch()`
  logs and `process.exit(1)`. The `pg.Pool` is `await pool.end()`-closed in
  both the success and error paths to avoid hanging the script.

## Acceptance criteria

| AC | Verification |
|---|---|
| AC-1 | File exists at `packages/db/src/scripts/seed_forms_observation.ts` |
| AC-2 | Script loads dotenv, checks `DATABASE_URL`, opens `pg.Pool` |
| AC-3 | Supports `SEED_DRY_RUN=true` short-circuit |
| AC-4 | Looks up `observation_cycles` row where `code = 'OBS-2026-001'` |
| AC-5 | Inserts 3 rows into `observation_forms` with `kind` ∈ {pre, post, observer} |
| AC-6 | Uses `.onConflictDoNothing()` for idempotence |
| AC-7 | `pre` template has lessonPlanSummary, learningOutcomes, anticipatedDifficulties |
| AC-8 | `post` template has whatWorked, whatDidNot, surpriseMoments, nextTime |
| AC-9 | `observer` template has 5 scale fields + narrativeComments |
| AC-10 | Each `scale` field declares min:1, max:5, anchors array of length 5 |
| AC-11 | `schemaVersion: "1"` written explicitly on every row |
| AC-12 | Top-level catch closes pool and exits 1 |

## Schema gaps / deviations

- **No `observation_form_templates` table exists** — the schema is locked.
  The brief instructed "Use observation_forms table for these (NOT
  feedback_forms — different table)" while also saying "Schema shape same as
  feedback_forms (fields array)". The two are slightly contradictory because
  `observation_forms` is a per-cycle-response table (FK `cycleId` NOT NULL,
  unique `(cycleId, kind)`), not a catalog. We therefore park the three
  template fixtures on the canonical seed cycle `OBS-2026-001` using the
  existing `responses` jsonb column with a top-level `fields` key. The form
  UI reads its template by fetching the lone row whose `cycle.code =
  'OBS-2026-001'` and `kind = '<pre|post|observer>'`. Recorded under
  `designDeviations` so the audit log is honest.

## Out of scope

- The form-rendering UI itself — that belongs to a sibling spec in this fan-out.
- A migration to add `observation_form_templates` table — schema is locked
  for this run; templates ride on the canonical cycle for now.
- Bilingual prompt strings — the `fields[].label` is English-only; a
  follow-up i18n spec can add a parallel `labelHi` key without a migration.

## Audit hooks

None — this is a seed script run by ops, not a user-facing action. It does
not touch the `learners` table, so SM-9 does not apply.
