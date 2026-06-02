# Spec 153 — Repo detail fixes + mentor_pairings.teacher_id index (Workflow Run 14 audit closure)

## Why

The 7-agent code audit at the close of Workflow Run 13 flagged three
independent MEDIUM-severity findings on the Repository surface (specs
046-056) plus one in the mentorship schema (spec 020). Each is a one-line
fix in isolation; consolidating them under a single spec keeps the
ledger compact and the next migration index sequential.

### 1. /repo/mentor/[id] does not filter on `mentors.active = true`

`apps/web/src/app/(authenticated)/repo/mentor/[id]/page.tsx:41-42`
reads the mentor row by `id` only. The mentors index page
(`/repo/mentors/page.tsx:39`) filters `eq(mentors.active, true)` so a
soft-retired mentor disappears from the list — but the detail URL
remains reachable, returning a fully-rendered profile for someone the
operator believed they had retired. The mentors schema uses an
`active boolean` column (not `deletedAt`); the fix mirrors the index
page's predicate.

### 2. /repo/sessions does not catch Postgres date-cast errors

`apps/web/src/app/(authenticated)/repo/sessions/page.tsx:62-63`
validates the `from` / `to` query params against
`ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/`. The regex accepts shape-correct
but calendar-invalid strings like `2026-13-45` or `2026-02-30`.
Postgres then throws `date/time field value out of range` on the cast
when the WHERE clause runs, surfacing as a 500 to the user instead of
a graceful filter-skip. The form's `<input type="date">` will never
produce these strings, but a hand-crafted URL (bookmark, share-link
truncation, or curious user) can. The fix layers a `new Date(value)`
parse + `!isNaN()` + a Y-M-D round-trip equality check after the
regex, so malformed values silently drop the filter rather than
500ing the page.

### 3. mentor_pairings.teacher_id has no index

`packages/db/src/schema/mentorship.ts` declares the FK
`teacher_id → teachers.id` but no `index()` on it. The compound
unique `(mentor_id, teacher_id, started_at)` exists, but its leading
column is `mentor_id` — a "lookup all pairings for teacher X" query
(used by `/repo/teacher/[id]` and the mentee-history join) cannot
use that index. At the current 120-row scale the seqscan is
invisible; at the projected mentor × pairing-history scale (10
mentors × 50 teachers × ~quarterly turnover) the planner will read
the entire table on every teacher-detail page load. A single-column
btree index on `teacher_id` is cheap to maintain (writes are at
mentor-assignment cadence, not per-request) and turns the read into
an index seek.

## What we ship

### `apps/web/src/app/(authenticated)/repo/mentor/[id]/page.tsx` (EDITED)

- Import `and` from `drizzle-orm` alongside `eq` / `desc`.
- The mentor SELECT's WHERE clause becomes
  `and(eq(mentors.id, id), eq(mentors.active, true))`. `notFound()` is
  called for any soft-retired or non-existent mentor — the page no
  longer renders detail for a row the index hides.
- Header comment carries a `Spec 153` reference explaining the
  predicate, including the note that mentors use `active boolean`
  (not `deletedAt`).

### `apps/web/src/app/(authenticated)/repo/sessions/page.tsx` (EDITED)

- Adds a module-level helper `parseIsoDateFilter(value)` that:
  1. Returns `undefined` if the input is falsy or fails
     `ISO_DATE_RE.test(...)`.
  2. Constructs `new Date(value + "T00:00:00Z")` and checks
     `!isNaN(parsed.getTime())`.
  3. Round-trips through `parsed.toISOString().slice(0, 10)` and
     verifies equality with the input. This catches "2026-13-45"
     (which `Date` silently normalises to "2027-02-14") and
     "2026-02-30" (silently → "2026-03-02"). Both pass the regex AND
     the `!isNaN` check but represent a different calendar day than
     the user-supplied string.
- `fromFilter` and `toFilter` are derived via
  `parseIsoDateFilter(sp.from)` / `parseIsoDateFilter(sp.to)`. A bad
  value silently drops the filter (the user gets the unfiltered list);
  we do not surface a 400 because the URL is normally produced by
  the date-input and the bad URL is a defensive case, not a UX flow.
- Header comment carries a `Spec 153` reference.

### `packages/db/src/schema/mentorship.ts` (EDITED)

- Adds `index("mentor_pairings_teacher_idx").on(t.teacherId)` to the
  `mentorPairings` table's constraint array, slotted between
  `mentor_pairings_status_idx` and the existing CHECK constraints to
  preserve declaration order with the snapshot.
- Inline comment explains why the existing compound unique can't
  satisfy "by-teacher" lookups (leading column is mentor_id).

### `packages/db/src/migrations/0018_index_mentor_pairings_teacher.sql` (CREATED)

- Single `CREATE INDEX "mentor_pairings_teacher_idx" ON
  "mentor_pairings" USING btree ("teacher_id");` statement.
- Header comment documents the rationale (compound-unique leading-
  column limitation, current vs projected scale, why NOT
  CONCURRENTLY — drizzle-kit wraps in a transaction).

### `packages/db/src/migrations/meta/0018_snapshot.json` (CREATED)

- Carry-forward of the 0017 snapshot with two edits: the snapshot
  `id` becomes a new UUID, the `prevId` chains off 0017's id, and
  the `mentor_pairings.indexes` map gains
  `mentor_pairings_teacher_idx`.

### `packages/db/src/migrations/meta/_journal.json` (EDITED)

- New journal entry: `idx: 18`, `tag:
  "0018_index_mentor_pairings_teacher"`, sequential `when`
  timestamp after 0017's.

## Acceptance criteria

- `/repo/mentor/[id]/page.tsx` imports `and` from `drizzle-orm`.
- The mentor SELECT WHERE clause is
  `and(eq(mentors.id, id), eq(mentors.active, true))`.
- `/repo/sessions/page.tsx` declares a `parseIsoDateFilter` helper
  with the regex + Date parse + round-trip equality logic.
- `fromFilter` and `toFilter` are derived via `parseIsoDateFilter`.
- `packages/db/src/schema/mentorship.ts` declares
  `index("mentor_pairings_teacher_idx").on(t.teacherId)` inside the
  `mentorPairings` constraint array.
- `0018_index_mentor_pairings_teacher.sql` contains
  `CREATE INDEX "mentor_pairings_teacher_idx" ON "mentor_pairings"`.
- `0018_snapshot.json` declares `mentor_pairings_teacher_idx` under
  `tables["public.mentor_pairings"].indexes`.
- `0018_snapshot.json.prevId` equals `0017_snapshot.json.id`.
- `_journal.json` includes an entry with
  `tag: "0018_index_mentor_pairings_teacher"` and `idx: 18`.
- All five spec-kit files exist under
  `specs/153-repo-fixes-and-pairings-index/`.
- `tests/governance/test_153_repo_fixes_and_pairings_index.test.mjs`
  passes with at least eight assertions covering the above.

## Non-goals

- **No deletedAt column.** The audit could have suggested a soft-
  delete migration to mentors, but `active boolean` already serves
  the same role (the seed and admin-registry layers respect it). A
  schema migration here would invite a second find/replace pass
  across observation, mentee-history, and the admin registry — out
  of scope for an audit-closure MEDIUM.
- **No 400 for malformed dates.** The session filter falls back to
  "no filter" silently because the bad URL is defensive, not a UX
  flow. A 400 would surface the validation error to a user whose
  URL the form would never produce.
- **No additional indexes.** The audit mentioned other tables with
  possibly-suboptimal index coverage (transcode_jobs, video_
  submissions); each is its own analysis with EXPLAIN traces.
  Bundling them into a single migration would couple unrelated
  decisions. This spec scopes to the one finding that has a clear
  query pattern and a measurable index-seek win.
- **No CONCURRENTLY clause.** drizzle-kit's migrate runner wraps each
  migration in a transaction; CONCURRENTLY is incompatible with
  transactional DDL. At the current 120-row scale the brief
  exclusive lock during CREATE INDEX is single-digit milliseconds
  and invisible to users.
