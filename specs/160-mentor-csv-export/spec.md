# Spec 160 — Mentor CSV export (Workflow Run 15 audit closure, MISS)

## Why

The 7-agent code audit at the close of Workflow Run 13 flagged a MISS:
`/repo/mentors` had no CSV-export button. The three sibling repository
index pages each had one:

- `/repo/schools` — links to `/repo/schools.csv` in the filter card.
- `/repo/teachers` — has a `{rows.length} shown` chip in lieu of a
  download, but the generic admin grid covers the entity.
- `/repo/students` — surfaces an `Export CSV` button gated to
  `super_admin` (SM-9 PII contract) and routed to
  `/api/admin/learners/export` (the dedicated PII-aware endpoint).

Mentors were the outlier. The generic
`/api/admin/data/[entity]/export` route does work against the mentors
entity (it's registered in `apps/web/src/admin/registry.ts`) but only
emits the entity's `displayColumns` — for mentors those are
`[name, bio, active]` which is a strict subset of what an operator
auditing the directory needs. The audit closure asks for:

- `id` — UUID, joinable against the audit log and any future
  cross-referencing.
- `name` — English name (mandatory column on the schema).
- `hindiName` — Devanagari name (SM-7: always nullable; empty string
  when missing).
- `baseLocation` — `"Leh"` or `"Kargil"` (v2 spec 020 addition).
- `expertiseAreas` — `jsonb` column holding `string[]`; emitted as
  JSON-stringified payload so the CSV can round-trip through the
  import path.
- `pairingsActive` — count of mentor_pairings rows with
  `status = "active"`, joined inline so the export reflects current
  load not lifetime history.

The pairings join is what makes the generic export insufficient — the
generic SELECT shape can't express a LEFT JOIN with GROUP BY against a
sibling table. Hence a dedicated route under
`/api/admin/data/mentors/export`.

## What we ship

### `apps/web/src/app/api/admin/data/mentors/export/route.ts` (CREATED)

GET-only API route that:

- Reads `session = await auth()`. No session → 401 JSON
  (`{error: "unauthenticated"}`).
- Gates `session.user.role` to `super_admin` OR `programme_admin`.
  Anything else → 403 JSON (`{error: "forbidden"}`). The `mentor`
  role itself is deliberately NOT in the allowlist — mentors can view
  the index (it's their peers) but not bulk-export the directory.
- Joins `mentor_pairings` filtered to `status = "active"` via a
  GROUP BY subquery aliased `pairing_counts`, so each mentor row gets
  a `pairingsActive` count in one round-trip.
- Selects the six columns above, ordered by mentor name.
- Calls `void recordAudit({ action: "mentors.bulk_export", entityType:
  "mentors", metadata: { rowCount } })` AFTER the SELECT (so `rowCount`
  is accurate). The `void` is deliberate — audit-channel failure must
  not block the user-facing 200 (mirrors the learners export at
  `apps/web/src/app/api/admin/learners/export/route.ts` line 96).
- Returns `Response(csv, { headers: { Content-Type: "text/csv;
  charset=utf-8", Content-Disposition: 'attachment;
  filename="mentors-YYYY-MM-DD.csv"' } })`.
- Exports `POST`, `PUT`, `DELETE`, `PATCH` handlers that all return
  405 `{error: "method_not_allowed"}` for method matrix completeness.

### `apps/web/src/app/(authenticated)/repo/mentors/page.tsx` (EDITED)

Adds a `Download CSV` anchor in the page header (right side, mirrors
the `/repo/students` "Export CSV" button placement at lines 86-94).

- Visible only when `session.user.role` is `super_admin` or
  `programme_admin` — same gate as the route handler. Hiding the
  button when the role would 403 removes the dead-link UX.
- `href="/api/admin/data/mentors/export"`, `className="btn btn-primary
  btn-sm"`, `data-testid="mentors-csv-export"` for future Playwright
  scraping.
- A new flex wrapper around the existing h1+p+label markup so the
  button can sit flush-right without disturbing the heading column.

## Acceptance criteria

- `apps/web/src/app/api/admin/data/mentors/export/route.ts` exists and
  exports a `GET` handler.
- The route returns 401 JSON on no session, 403 JSON on disallowed
  role, 405 JSON on POST/PUT/DELETE/PATCH.
- The SELECT joins `mentor_pairings` and projects six columns: `id`,
  `name`, `hindiName`, `baseLocation`, `expertiseAreas`,
  `pairingsActive`.
- The response carries `Content-Type: text/csv; charset=utf-8` and a
  `Content-Disposition: attachment; filename="mentors-YYYY-MM-DD.csv"`
  header.
- An audit row is written with `action = "mentors.bulk_export"` after
  the SELECT.
- `apps/web/src/app/(authenticated)/repo/mentors/page.tsx` contains a
  `Download CSV` anchor pointing at the new route, gated on the
  role-check helper.
- All five spec-kit files exist under `specs/160-mentor-csv-export/`.
- `tests/governance/test_160_mentor_csv_export.test.mjs` passes with
  at least 6 assertions.

## Non-goals

- **No schema change.** The mentor + mentor_pairings tables already
  have every column the export needs. Migration index 0019 stays
  reserved for spec 159, 0020 for spec 161.
- **No new dependencies.** `papaparse` is already a workspace dep
  used by the learners export and the generic admin CSV path.
- **No import path.** The reverse (CSV → mentor rows) is covered by
  the generic admin grid's import handler (registered via the
  mentors entity in `apps/web/src/admin/registry.ts`). This spec is
  export-only.
- **No SM-9 escalation.** Mentors are programme staff, not children;
  the export gate is the SM-1 standard admin gate, not the
  super_admin-only SM-9 gate that learners require.
- **No filter parameters.** The learners export accepts `?school=`;
  mentors don't have an analogous narrowing axis (the index page
  itself doesn't filter). A future spec can add `?base=Leh|Kargil`
  if operators ask for it.
