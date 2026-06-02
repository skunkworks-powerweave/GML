# Tasks 153

- [x] T1 → write the governance test (red) covering:
  - `/repo/mentor/[id]/page.tsx` imports `and` from drizzle-orm and
    the SELECT WHERE clause uses `eq(mentors.active, true)`;
  - `/repo/sessions/page.tsx` declares a `parseIsoDateFilter` helper
    with regex + Date + round-trip equality logic AND derives
    fromFilter / toFilter through it;
  - `packages/db/src/schema/mentorship.ts` declares
    `mentor_pairings_teacher_idx` on `teacherId`;
  - `0018_index_mentor_pairings_teacher.sql` contains the
    CREATE INDEX statement;
  - `0018_snapshot.json` declares the index AND chains its prevId
    off 0017's id;
  - `_journal.json` carries a `0018_index_mentor_pairings_teacher`
    entry with `idx: 18`;
  - all five spec-kit files exist under
    `specs/153-repo-fixes-and-pairings-index/`;
  - the mentor page, sessions page, and migration carry an inline
    "Spec 153" comment marker.
  Run suite → red.
- [x] T2 → edit `apps/web/src/app/(authenticated)/repo/mentor/[id]/page.tsx`:
  import `and` from drizzle-orm; switch the SELECT WHERE to
  `and(eq(mentors.id, id), eq(mentors.active, true))`; add header
  comment block referencing Spec 153 and the rationale (mentors
  use `active boolean`, not `deletedAt`). Run scoped governance
  test → mentor-active assertions green.
- [x] T3 → edit `apps/web/src/app/(authenticated)/repo/sessions/page.tsx`:
  add module-level `parseIsoDateFilter` helper with the regex +
  Date parse + round-trip equality logic; rewrite the `fromFilter` /
  `toFilter` derivations to call the helper; add header comment
  referencing Spec 153 and the rationale. Run scoped governance
  test → session-filter assertions green.
- [x] T4 → edit `packages/db/src/schema/mentorship.ts`: insert
  `index("mentor_pairings_teacher_idx").on(t.teacherId)` between
  the existing `mentor_pairings_status_idx` and the CHECK
  constraints. Add inline comment explaining why the compound
  unique can't satisfy by-teacher lookups (leading column is
  mentor_id). Run scoped governance test → schema-declaration
  assertion green.
- [x] T5 → create `packages/db/src/migrations/0018_index_mentor_pairings_teacher.sql`:
  single CREATE INDEX statement with rationale-bearing header
  comment. Run scoped governance test → migration-SQL assertion
  green.
- [x] T6 → create `packages/db/src/migrations/meta/0018_snapshot.json`:
  copy 0017_snapshot.json, change `id` to a fresh UUID, change
  `prevId` to 0017's id, add `mentor_pairings_teacher_idx` to
  `tables["public.mentor_pairings"].indexes`. Run scoped
  governance test → snapshot-chain + snapshot-index assertions
  green.
- [x] T7 → edit `packages/db/src/migrations/meta/_journal.json`:
  append the 0018 entry with `idx: 18` and a sequential `when`
  timestamp after 0017's. Run scoped governance test →
  journal-entry assertion green.
- [x] T8 → author all five spec-kit files under
  `specs/153-repo-fixes-and-pairings-index/`.
- [x] T9 → run the full governance suite. Confirm no regression.
  The only state-shape changes are (a) the mentor SELECT
  narrowing (any row that rendered before now either still
  renders or 404s — never a different row), (b) the date
  filter refinement (any value the old regex accepted is still
  accepted IFF it parses to a valid calendar date), and (c) the
  additive non-unique index (no constraint change).
- [ ] T10 (future, out of scope) → audit other repo detail pages
  (school, class, teacher, subject, outline, resource) for the
  same "missing active filter" pattern. The teacher and subject
  pages already filter; school/class/outline/resource have
  different soft-delete semantics (or none) so the audit needs
  a per-page review.
- [ ] T11 (future, out of scope) → consider migrating to a Zod
  schema layer for searchParams parsing across the entire
  Repository surface. Three call sites today
  (sessions / videos / cycles); revisit at ~6 to amortise the
  dependency cost.
- [ ] T12 (future, out of scope) → EXPLAIN trace the
  /repo/teacher/[id] query under production-scale (~5000
  mentor_pairings rows). If the index seek dominates, consider
  promoting to a compound index `(teacher_id, started_at DESC)`
  to skip the sort step.
