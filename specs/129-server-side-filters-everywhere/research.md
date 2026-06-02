# Research 129

Four design choices documented inline in the affected pages.

## (1) Why `<Link>`-driven chips for fixed enums but `<form method="GET">` for free-form filters

Status / kind / district / pairing-status take one of a few known
values — a chip strip with a `<Link>` per option is the right
shape: it surfaces all choices visually, the active selection is
obvious from the inked background, and a click round-trips through
Postgres without any JS.

Grade-range / subject-id / school-id / date-range have larger
option sets (12 grades, 10+ subjects, 60+ schools, an unbounded
date space). A chip strip would either swallow the layout or
hide options behind "more…". A native HTML `<form method="GET">`
with `<select>` + date inputs is the same UX the rest of the
admin app already uses (`/admin/audit`, `/admin/whatsapp-log`,
`/admin/data/*`). Apply button submits, browser URL updates,
server re-renders with the new filter. No client component.

## (2) Why count aggregates come from a separate GROUP BY round-trip

The filter chips show `Status (N)` totals so the operator can see
the slice size before they click. If we counted from
`rows.length` inline, the count would shrink to "rows visible
under the current filter" — which is the wrong number (the
"All" chip would always show the same count as whatever filter
was active).

A second `select count(*)::int from … group by status` is one
extra round-trip per page render. The roll-up runs over the
indexed status column so it's near-instant even at scale, and
the result is a stable per-tab count regardless of which filter
is active. Same shape `/repo/resources` already uses (spec 055).

## (3) Why we still cap the result set at `limit(200)` / `limit(80)`

The whole point of moving the filter to SQL is so the cap
becomes meaningful. Before this spec, the page fetched 200 rows
and then narrowed in JS — if "complete" sessions were row #201
and beyond, the user would see "0 complete sessions" even though
the DB had 50. Now the WHERE happens first, then the LIMIT —
so "complete" returns up to 200 complete rows. A future spec
can add `?page=` pagination on top of the same filter envelope.

## (4) Why the schools page still accepts both "kgl" and "kargil"

The JSX prototype used `district === "kgl"` everywhere
(`repository.jsx:178-179`). The live `districts.code` column has
been seeded as `"KGL"` in some demo data and `"kargil"` in the
Ladakh v2 seed (spec 086). Older bookmarks and CSV imports still
ship "kgl". Rather than force a migration, the WHERE accepts
either via `ilike(districts.code, "kgl") OR ilike(districts.code,
"kargil") OR ilike(districts.name, "kargil")`. Same logic that
was previously running in JS — now in SQL.

## Why subject filter uses UUID validation

`subjects.id` is a UUID, not a free-form string. Letting any
arbitrary `?subject=foo` value land in `eq(sessions.subjectId, …)`
would either throw a Postgres cast error or silently match
nothing. We pre-validate against a UUID regex; non-UUID values
fall through to "all". Same pattern as `/admin/data/*` admin
grids.

## Why teacher current-phase filter uses `phases.id` not `phases.label`

The `teachers.current_phase_id` FK is the canonical handle. The
JSX prototype filters by `t.phase` (a string label) because the
mock data had a label column. The live schema has `currentPhaseId`
+ a `phases` table joined on it. Filtering by phase UUID survives
phase renames (which the no-code admin can do at any time).
