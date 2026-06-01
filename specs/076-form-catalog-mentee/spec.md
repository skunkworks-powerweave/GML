# Spec 076 — Form catalog: mentee (teacher) feedback forms

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 8 (Forms & quizzes)

## Context

The mentorship cycle (spec 060/061) has a documented four-form arc: **baseline** → **progress (Q1)** → **progress (Q2)** → **final**. Each pairing has *two* respondents per stage — the mentor and the mentee (the teacher being mentored). Spec 075 (sibling) seeds the mentor-side templates; this spec seeds the **mentee** (teacher) side.

`feedback_forms` rows are referenced by:
- the form catalog page (spec 074),
- the mentorship detail page (spec 061) — "Q1 progress · awaiting teacher feedback" panels,
- the renderer (spec 073) — looks up `feedback_forms.schema` by `(kind, audience, version)`,
- the autosave layer (spec 072) — `form_drafts.templateId → feedback_forms.id`.

We seed **four mentee-audience templates**: `(baseline, mentee)`, `(progress_1, mentee)`, `(progress_2, mentee, version="2")`, `(final, mentee)`. The Q2 form is version `"2"` to demonstrate that the schema supports superseding a kind/audience combo without breaking the unique index `feedback_forms_kind_audience_version_uq`.

Forms are **idempotent**: the seed checks `existsSync`-style with a SQL `SELECT EXISTS` against `(kind, audience, version)` before inserting, so repeated `pnpm --filter @gml/db seed:forms-mentee` calls are no-ops on a populated database. The same script also surfaces a `rowCount` summary at the end.

The schema JSON shape mirrors the field-descriptor convention used by the renderer (spec 073): each field is `{ id, label, hindiLabel?, type, required, options? }`. Types used: `likert_5` (1-5 numeric Likert), `textarea` (free-text), `radio` (yes/no for the recommend question).

## Functional Requirements

- **FR-001** — `packages/db/src/scripts/seed_forms_mentee.ts` is a runnable tsx script: `tsx packages/db/src/scripts/seed_forms_mentee.ts`. Loads `dotenv/config`. Reads `DATABASE_URL`. Exits 1 with a clear error if unset.
- **FR-002** — Connects via `pg.Pool` + `drizzle-orm/node-postgres`, imports schema from `../schema/index.js` (mirrors `seed.ts` convention).
- **FR-003** — Inserts exactly **4 rows** into `feedback_forms`:
  - `(kind="baseline", audience="mentee", version="1", active=true)` with 9 fields covering identity context, current grade, biggest classroom challenge, language-of-instruction confidence (English / Hindi-Urdu / Ladakhi), and mentorship expectations.
  - `(kind="progress_1", audience="mentee", version="1", active=true)` with 8 fields covering confidence shift, most useful mentor input so far, still-struggling-with, and English-instruction confidence re-check.
  - `(kind="progress_2", audience="mentee", version="2", active=true)` — same shape as Q1 with 9 fields (adds an "open feedback to your mentor" item). Version bumped to `"2"` per the brief; demonstrates `feedback_forms_kind_audience_version_uq` allowing supersedence.
  - `(kind="final", audience="mentee", version="1", active=true)` with 10 fields covering overall growth (Likert), would-recommend (radio yes/no), language-confidence retrospective, biggest takeaway (textarea), and open feedback.
- **FR-004** — Each row's `schema` jsonb contains an object `{ title, audience: "mentee", fields: FieldDescriptor[] }`. Field counts are within 8-14 per the brief; the four forms are 9, 8, 9, 10 respectively.
- **FR-005** — Hindi labels (SM-7) are populated as **optional** glosses on every field with a natural Hindi rendering. The renderer (spec 073) shows them in `var(--deva)` and skips when null. Seed always provides them for the mentee forms so the Hindi UX is testable.
- **FR-006** — **Idempotency**: before inserting each row, the script runs `SELECT id FROM feedback_forms WHERE kind = $1 AND audience = $2 AND version = $3 LIMIT 1`. If a row already exists the insert is skipped and a `[skip]` line logged. Final summary prints the inserted count + skipped count.
- **FR-007** — A `SEED_DRY_RUN=true` environment variable short-circuits before any insert and just logs the planned rows. Mirrors the pattern in `seed.ts`.
- **FR-008** — Process exits 0 on success, 1 on error (uncaught via `.catch`). `pool.end()` always runs.

## Acceptance Criteria → behaviors

| Behavior | Verification |
| --- | --- |
| Script file exists at the documented path | governance test asserts `existsSync` |
| Inserts 4 distinct `(kind, audience, version)` rows | source contains 4 audience: "mentee" literal occurrences and the 4 expected kinds |
| Idempotent — re-running is safe | source contains a `SELECT id FROM feedback_forms WHERE kind` style guard before inserts |
| Q2 is version "2" — supersedence demonstrated | source contains `version: "2"` |
| Hindi labels populated (SM-7) | source contains 4+ `hindiLabel:` keys |
| Uses pg Pool + drizzle ORM | imports `pg` + `drizzle-orm/node-postgres` |
| Reads DATABASE_URL via dotenv | imports `dotenv/config` |
| Realistic Ladakh teacher questions | source contains `Ladakhi`, `Urdu`, `English` literal strings |
| Likert-5 scale used | source contains `likert_5` type literal |
| Yes/no recommend question on final | source contains `radio` type + `Yes`/`No` options |

## Audit hooks / SM concerns

- **SM-7** — Hindi labels are populated on every field but the *renderer* (spec 073) treats them as optional and renders only when present. We populate to make the bilingual UX testable in dev.
- **SM-8** — N/A (no notifications written).
- **SM-9** — **Not relevant**. The seed touches `feedback_forms` only — no `learners` rows. PII audit not required.

## Out of scope

- Mentor-side templates (spec 075).
- Observation form templates (spec 077).
- Quiz seeds (spec 078–080).
- Migrating *existing* `feedback_responses` rows when version bumps (no historical data to migrate — pre-launch).
