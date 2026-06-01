# Spec 078 — Form catalogue: school-visit checklist + endline survey

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 8 (Forms & quizzes)

## Overview

Seeds two miscellaneous feedback forms into `feedback_forms` to round out the catalogue: a **school-visit checklist** (used by mentors and observers during a campus visit) and an **endline survey** (used by mentees at programme close). Both ride the existing `feedback_forms` table introduced in spec 020. The JSON `schema` column carries the rendering definition — field id, kind (`boolean | rating | textarea | single-choice | text`), label, optional Hindi gloss, options. Forms are idempotently upserted by the natural key `(kind, audience, version)` matching the table's unique index. This script complements specs 074–077 which seed the four quarterly mentorship forms (baseline / progress_1 / progress_2 / final, each per audience).

### Schema deviation (documented, route-around)

The brief asks for `kind=schoolvisit` and `kind=endline`, and `audience=teacher` (or programme-wide), but **`feedbackKindEnum` only contains `baseline | progress_1 | progress_2 | final`** and **`feedbackAudienceEnum` only contains `mentor | mentee`**. Schema is locked (no new columns / no new enum values in Phase 8). We route around by:

1. **School-visit checklist** → reuses `kind="baseline"` + `audience="mentor"` with `version="schoolvisit-1"`. Distinct version keeps the unique index happy; renderer dispatches on the embedded `purpose: "schoolvisit"` field in the JSON schema.
2. **Endline survey** → reuses `kind="final"` + `audience="mentee"` with `version="endline-1"`. Same routing: `purpose: "endline"` inside the schema JSON.

This is a documented deviation (see `designDeviations`) — when a future migration adds the enum values, the seed can be re-keyed without losing existing rows (versions stay unique).

## Functional Requirements

- **FR-001** — `packages/db/src/scripts/seed_forms_misc.ts` runs as a standalone tsx script reading `DATABASE_URL` from env, opening a `pg.Pool`, and inserting exactly two rows into `feedback_forms` if they are not already present.
- **FR-002** — **Idempotent.** The script must safely re-run. Idempotency key is the unique index `(kind, audience, version)`. Before insert, query existence by that triple; skip rows that already exist; log clearly whether each row was inserted or skipped.
- **FR-003** — **School-visit checklist schema** (FR rendering contract): array of fields with the following ids — `infra_observations` (boolean group, options: "Toilets functional", "Drinking water", "Furniture intact", "Blackboard usable", "Library room exists"), `morning_routine_observed` (boolean), `library_accessible` (boolean), `teacher_attendance_pattern` (single-choice: "Regular daily", "Mostly regular", "Irregular", "Frequently absent"), `classroom_hygiene_rating` (rating 1–5), `notes` (textarea, optional). Field labels carry an optional `hindiLabel` (SM-7) so the renderer can show Devanagari under the English label.
- **FR-004** — **Endline survey schema** (FR rendering contract): array of fields — `years_in_programme_reflection` (textarea, prompt "What did the programme do for you across the years?"), `top_three_learnings` (textarea, 3 lines suggested), `would_mentor_next_cohort` (single-choice yes/no), `improvement_suggestions` (textarea, optional). Same SM-7 Hindi gloss support.
- **FR-005** — Each form row carries `active=true` and `version` containing the natural suffix (`schoolvisit-1`, `endline-1`). The script logs the resulting row ids and a summary count.
- **FR-006** — Script must DRY-RUN if `SEED_DRY_RUN=true` — print what would be inserted then exit without writing. Mirrors `seed.ts`'s convention.
- **FR-007** — Pool must be closed on both happy and error paths (`finally` or `pool.end()` before `process.exit`). No connection leaks.

## Acceptance Criteria

| Behaviour | Verification |
| --- | --- |
| 2 rows seeded on fresh DB | Run script once → exit code 0; SELECT count = 2 with versions `schoolvisit-1`, `endline-1` |
| Re-run is safe | Run script twice → second run logs "skipped" for both; SELECT count remains 2 |
| Schema field shapes correct | SELECT `schema->>'purpose'` returns `schoolvisit` / `endline` accordingly |
| SM-7 Hindi gloss optional | Spec schema permits `hindiLabel` to be absent without renderer failure |
| Idempotency key | Insert path uses `(kind, audience, version)` uniqueness — not surrogate id |

## Audit hooks

None. Seeding form catalogue entries is not a learner-PII flow; SM-9 is N/A. The script is operator-run (one-shot) and there is no end-user trigger.

## Out of scope

- Renderer / submission UI for these forms (covered by spec 080 — form rendering, not in scope here).
- Migration to add `feedbackKindEnum` values `schoolvisit` and `endline` (future enum migration; deferred so we don't unlock schema mid-Phase-8).
- A `teacher`-only audience (no enum value; the endline survey is keyed to `mentee` audience by convention).
