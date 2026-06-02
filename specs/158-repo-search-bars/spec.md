# Spec 158 — Inline name-search bars on every /repo/* index (Workflow Run 15 audit closure, MISS)

## Why

The 7-agent audit at the close of Workflow Run 14 flagged a feature gap
that QA had been working around since spec 121 (`Quick Find` ⌘K) shipped:
every `/repo/*` index page (schools, teachers, mentors, subjects,
sessions, resources, outlines) supports filtering by category — district,
school × phase, grade, status, kind, etc — but not by name.

The workaround was to open ⌘K → Quick Find → type the name → click
through. That round-trip takes 4 actions for what should be one. The
gap also shows up in the URL: a filtered repo view (e.g. "all schools
in Leh") is bookmarkable, but "all schools matching 'CHU'" is not.

This spec closes the gap by adding a single `?q=` URL search parameter
to each of the 7 repo index pages. The query narrows the listing via
`ILIKE %q%` on the primary name column (schools.name, teachers.fullName,
mentors.name, subjects.name, sessions.topic, resources.name,
courseOutlines.name) and combines with the existing category filters
via `and(...)`. The input renders inline with the existing filter form,
uses a native HTML `method="GET"` so no client component is needed, and
the URL stays a single shareable bookmark.

The `/repo/students` page is intentionally NOT touched in this spec —
SM-9 audits every render of that page, and a fast-typing user would
flood the audit log with `learners.bulk_view` rows. If a name search
on /repo/students becomes a need, a follow-up spec can layer in
debounced submission + per-query audit dedup.

## What we ship

Seven index pages get a `?q=` URL search parameter, an inline `<input
type="search" name="q">` form control rendered with the existing filter
card, and an `and(...)`-combined WHERE clause that adds the ILIKE
predicate to whatever filters are already in flight.

### `apps/web/src/app/(authenticated)/repo/schools/page.tsx` (EDITED)

- `SearchParams` gains optional `q?: string`.
- New module-level `SEARCH_Q_MAX = 200` constant + `escapeIlike(s)`
  helper that escapes `%`, `_`, and `\` so a literal underscore in a
  school code doesn't become a wildcard.
- `qFilter` derives from `sp.q.slice(0, SEARCH_Q_MAX).trim()`; empty
  string and all-whitespace both treat as absent.
- The existing district WHERE clause becomes `and(active, districtCond,
  qCond)` with each predicate conditional.
- The filter card gains an inline `<form method="GET" action="/repo/
  schools">` carrying an `<input type="search" name="q">` plus a Search
  button and a Clear link (visible only when `qFilter` is active). The
  active district tab is preserved via a hidden input. Each district
  tab href preserves `q` so the search survives a district narrowing.

### `apps/web/src/app/(authenticated)/repo/teachers/page.tsx` (EDITED)

- `SearchParams` gains optional `q?: string`.
- ILIKE predicate on `teachers.fullName` joins the existing
  school/phase conds array.
- The existing filter form gains a `<label>Name<input
  type="search" name="q">` field as the first form control.
- Reset button is renamed Clear; visible when any of school/phase/q is
  active.

### `apps/web/src/app/(authenticated)/repo/mentors/page.tsx` (EDITED)

- New `searchParams` prop (the page was previously prop-less).
- ILIKE predicate on `mentors.name` joins the active gate via `and(...)`.
- A new filter card is added (the page had none); a single search
  input form sits at the top of the page body.

### `apps/web/src/app/(authenticated)/repo/subjects/page.tsx` (EDITED)

- `searchParams` accepts optional `q?: string`.
- ILIKE predicate on `subjects.name` joins the grade-range conds array.
- The existing grade-filter form gains a Name input as the first
  control. Reset button is renamed Clear.

### `apps/web/src/app/(authenticated)/repo/sessions/page.tsx` (EDITED)

- `SearchParams` gains optional `q?: string`.
- ILIKE predicate on `sessions.topic` (sessions don't have a "name";
  topic is the primary user-visible label) joins the existing
  conds array.
- The existing subject/from/to form gains a topic search input.
- Each status-tab href preserves `q` via the existing
  URLSearchParams builder.
- Clear link added beside Apply when `qFilter` is active.

### `apps/web/src/app/(authenticated)/repo/resources/page.tsx` (EDITED)

- `searchParams` accepts optional `q?: string`.
- ILIKE predicate on `resources.name` joins the existing kind filter
  via and(...).
- A new search form card sits above the existing kind-pill row.
- Each kind pill preserves `q` across clicks.

### `apps/web/src/app/(authenticated)/repo/outlines/page.tsx` (EDITED)

- `SearchParams` gains optional `q?: string`.
- ILIKE predicate on `courseOutlines.name` joins the existing
  grade/term/status conds array.
- The existing filter form gains a Name input as the first control.
- Reset button is renamed Clear; visible when any of the four filters
  is active.

## Acceptance criteria

Each of the 7 edited pages MUST:

- Declare `q?: string` on its `SearchParams` Promise type.
- Use the literal `ilike(<column>, ...)` predicate against the spec'd
  name column (escapeIlike wrapped).
- Cap the raw input at 200 chars and trim whitespace.
- Render an `<input type="search" name="q">` (max-length 200, aria-label
  set) inline with the existing filter form.
- Combine with existing filters via `and(...)` — no replacement of
  prior conditions.
- Provide a Clear link visible when `qFilter` is active.
- Use native HTML GET form submission — no client component, no
  useState, no useTransition.

Plus:

- All five spec-kit files exist under `specs/158-repo-search-bars/`.
- `tests/governance/test_158_repo_search_bars.test.mjs` passes with
  at least 8 assertions (one per edited page minimum).

## Non-goals

- **No /repo/students name search.** SM-9 audits every render; a name
  search would flood the audit log. A future spec can layer debounce
  + per-query audit dedup.
- **No fuzzy search / typo tolerance.** ILIKE is a substring match.
  pg_trgm would be nicer but introduces an extension dependency and an
  index-build step; out of scope.
- **No client-side instant search.** Native GET form submission keeps
  the URL shareable and avoids a new client component on each page.
- **No multi-column search.** The contract is "primary name column
  only". A later spec can extend to e.g. hindi_name on /repo/teachers
  if QA asks for it.
- **No schema change, no migration.** ILIKE works against the existing
  indexes (or a sequential scan with the 200-row LIMIT, fine at
  current scale).
