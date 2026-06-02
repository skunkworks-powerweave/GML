# Tasks 158

- [x] T1 → write the governance test (red) covering all 7 edited
  repo index pages:
  - each declares `q?: string` on its SearchParams Promise type;
  - each contains the literal `ilike(<column>, ...)` predicate
    against the spec'd name column (schools.name, teachers.fullName,
    mentors.name, subjects.name, sessions.topic, resources.name,
    courseOutlines.name);
  - each declares the `SEARCH_Q_MAX = 200` cap;
  - each contains the `escapeIlike` helper;
  - each renders an `<input type="search" name="q">` form control
    with `aria-label` set;
  - each gates a Clear link on `qFilter` being truthy;
  - each combines with existing filters via `and(...)` (no
    replacement of prior WHERE conditions).
  Run suite → red.
- [x] T2 → edit `apps/web/src/app/(authenticated)/repo/schools/page.tsx`:
  add `q?: string` SearchParams, `SEARCH_Q_MAX`/`escapeIlike` helpers,
  ILIKE on `schools.name` joined via `and(...)`, search input + Clear
  link, q-preserving district tab hrefs. Inline Spec 158 comments.
  Run scoped governance test → schools assertions green.
- [x] T3 → edit `apps/web/src/app/(authenticated)/repo/teachers/page.tsx`:
  add ILIKE on `teachers.fullName`, Name input as first form control,
  Reset → Clear, q gates the Clear visibility. Inline Spec 158 comments.
  Run scoped governance test → teachers assertions green.
- [x] T4 → edit `apps/web/src/app/(authenticated)/repo/mentors/page.tsx`:
  add `searchParams` prop, ILIKE on `mentors.name`, new filter card
  with a Name input + Clear at the top of the page body. Inline Spec
  158 comments.
  Run scoped governance test → mentors assertions green.
- [x] T5 → edit `apps/web/src/app/(authenticated)/repo/subjects/page.tsx`:
  add ILIKE on `subjects.name`, Name input as first control, Reset →
  Clear. Inline Spec 158 comments.
  Run scoped governance test → subjects assertions green.
- [x] T6 → edit `apps/web/src/app/(authenticated)/repo/sessions/page.tsx`:
  add ILIKE on `sessions.topic`, topic search input alongside subject/
  from/to, q-preserving status-tab hrefs, Clear link. Inline Spec 158
  comments.
  Run scoped governance test → sessions assertions green.
- [x] T7 → edit `apps/web/src/app/(authenticated)/repo/resources/page.tsx`:
  add ILIKE on `resources.name`, new search-bar card above the kind-
  pill row, q-preserving kind-pill hrefs. Inline Spec 158 comments.
  Run scoped governance test → resources assertions green.
- [x] T8 → edit `apps/web/src/app/(authenticated)/repo/outlines/page.tsx`:
  add ILIKE on `courseOutlines.name`, Name input as first control,
  Reset → Clear. Inline Spec 158 comments.
  Run scoped governance test → outlines assertions green.
- [x] T9 → author all five spec-kit files under
  `specs/158-repo-search-bars/`.
- [x] T10 → run the full governance suite. Confirm no regression — all
  seven edits are additive (new SearchParams field, new conds entry,
  new form control); the existing district/grade/status/kind/from/to
  filters continue to work unchanged.
- [ ] T11 (future, out of scope) → /repo/students name search. SM-9
  audits every render; adding a search would flood the audit log. A
  follow-up spec can layer per-query audit dedup before adding the
  search input.
- [ ] T12 (future, out of scope) → pg_trgm-backed fuzzy search. Cur-
  rent ILIKE substring search misses typos. A future spec that ships
  pg_trgm globally (docker image change + per-column GIST/GIN
  migrations) can swap the ILIKE for similarity() with a one-line
  helper change.
- [ ] T13 (future, out of scope) → multi-column search per page (e.g.
  search hindi_name on /repo/teachers, search code on /repo/schools).
  Current contract is single primary name column. QA can ask for it
  if needed.
- [ ] T14 (future, out of scope) → instant-search client component
  with debounce. Would require 7 new client components and would lose
  URL shareability. The native GET form is the correct trade-off for
  field-mentor low-bandwidth UX.
