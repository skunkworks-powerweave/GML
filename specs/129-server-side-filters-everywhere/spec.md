# Spec 129 — Server-side filters everywhere (Workflow Run 11 frontend-parity closure)

## Why

Workflow Run 10 shipped the JSX → Next.js port of 27 routes. Several
list pages kept the prototype's `useState` filter pattern: they
fetched a slab of rows server-side and then narrowed the visible
set in memory via `rows.filter(...)`. That's fine when the dataset
is small mock data — but the production tables for sessions /
teachers / observation cycles grow well past the page-size cap.
A user clicking the "Complete" status chip on `/repo/sessions`
expects to see *all* complete sessions, not "the complete subset
of the most recent 200". Today they see the wrong slice silently.

Spec 129 closes that gap. Every list page's filter UI gets rewired
so the selected value lands in the URL `searchParams` and reaches
the Drizzle `WHERE` clause directly. The visible 1:1 layout — the
same chip-strip + select + Apply button the JSX prototype shows —
stays untouched. Only the data path changes.

## Pages audited

| Route                | Existing filter UI? | Server-side before? | Server-side after this spec? |
| -------------------- | ------------------- | ------------------- | ---------------------------- |
| `/observation`       | no — strip was missing | n/a               | yes — status + kind                |
| `/repo/schools`      | yes, district links | URL-driven, in-mem filter | yes — `ilike(districts.code)` |
| `/repo/subjects`     | no                  | n/a                 | yes — grade-range form              |
| `/repo/outlines`     | no                  | n/a                 | yes — grade + term + status        |
| `/repo/sessions`     | yes, status + subject | client-side filter | yes — status + subject + from/to   |
| `/repo/teachers`     | no                  | n/a                 | yes — school + phase                |
| `/repo/resources`    | yes, kind chips     | yes (spec 055)      | unchanged — already SQL-side       |
| `/videos`            | yes, status chips   | client-side filter  | yes — status + source              |
| `/mentorship`        | no                  | n/a                 | yes — pairing status                |
| `/admin/audit`       | yes                 | yes (spec 116)      | unchanged                          |
| `/admin/whatsapp-log`| yes                 | yes (spec 126)      | unchanged                          |

## What we ship

1. **`/observation/page.tsx`** — port the JSX filter strip
   (`observation-list.jsx:41-65`) to two side-by-side chip groups
   for status (`nominated` / `pre_submitted` / `observed` /
   `post_submitted` / `complete`) and kind (`baseline` /
   `developmental` / `evaluative`). Each chip is a `<Link>`
   pointing at the same route with the updated searchParam. The
   server reads the params, validates against an enum allow-list,
   and pushes an `and(eq(...))` into the Drizzle query.

2. **`/repo/schools/page.tsx`** — remove the in-memory
   `matchesDistrict` filter. Build the WHERE on `districts.code`
   directly via `ilike(...)` so the existing "leh" / "kgl" /
   "kargil" prototype slugs keep working. Counts come from a
   single GROUP BY round-trip, not a `rows.filter().length`.

3. **`/repo/subjects/page.tsx`** — add a `?grade=N` URL filter
   that narrows to subjects whose `grades_min ≤ N ≤ grades_max`
   (NULL bounds = "all grades"). Visible UI: a one-control GET
   form with a "Grade" `<select>` (12 options) + Apply + Reset.

4. **`/repo/outlines/page.tsx`** — add grade + term + status
   filters via URL searchParams. The filter card is a GET form
   that submits three `<select>`s. All three filters narrow at
   the SQL layer; the 200-row cap stays.

5. **`/repo/sessions/page.tsx`** — convert the existing client-
   side `rows.filter(...)` into a SQL WHERE. The visible filter
   tabs (status chips + subject select) work the same. Adds a
   `?from=` + `?to=` date-range so the prototype's "More filters"
   affordance has an actual surface.

6. **`/repo/teachers/page.tsx`** — add `?school=` + `?phase=`
   filters (both UUIDs). The filter form is a GET that submits
   two `<select>`s seeded from the `schools` + `phases` tables.

7. **`/videos/page.tsx`** — the existing status filter chips
   become server-side. Adds a `?source=` filter (whatsapp /
   direct / external_link / google_drive) so operators can scope
   by ingest channel without dropping into `/admin/whatsapp-log`.

8. **`/mentorship/page.tsx`** — add a `?status=` filter
   (active / review / paused / complete / ended). Filter chips
   mirror the JSX prototype look (ink-on-paper for the active
   pill). Counts roll up from `mentor_pairings.status`.

## Acceptance criteria

- Every page above accepts a URL searchParam that narrows the
  Drizzle query (not a `rows.filter(...)` after-the-fetch step).
- The filter UI is HTML `<form method="GET">` or `<Link>`-based
  — no `"use client"` directive is introduced.
- Counts in the filter chips come from a `count(*)::int` SQL
  aggregate, not from the in-memory row count.
- The visible page chrome (className, layout grid, page-header
  copy) stays bit-identical to before for routes that already
  shipped chrome (schools / sessions / videos). The newly-added
  filter strips on observation / subjects / outlines / teachers /
  mentorship use the same `.card` + `.btn .btn-sm` patterns the
  rest of the app already uses.
- `tests/governance/test_129_server_side_filters_everywhere.test.mjs`
  passes with at least 10 assertions (one or more per affected
  page).
- All five spec-kit files exist under
  `specs/129-server-side-filters-everywhere/`.

## Non-goals

- No schema migration. Every column the filter needs already
  exists.
- No new dependencies.
- No CSV export hooks. The pages that need export already
  ship one (`/repo/schools.csv`, `/admin/audit`); a future spec
  can wire the new filter params into the export query string.
- No "Save filter as a view" persistence. URL-as-state is good
  enough — bookmarks + sharing already work.
- No pagination beyond what each page already does (`limit(200)`
  for the wide ones, `limit(80)` for the cycle/pairing pages).
  A future spec can wire `buildPageHref(page)` into the same
  searchParams envelope.
