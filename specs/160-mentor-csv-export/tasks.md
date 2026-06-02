# Tasks 160

- [x] T1 → write the governance test (red) covering:
  - `apps/web/src/app/api/admin/data/mentors/export/route.ts` exists;
  - GET handler exported;
  - 401 JSON `{error:"unauthenticated"}` on no session;
  - 403 JSON `{error:"forbidden"}` on disallowed role;
  - 405 JSON `{error:"method_not_allowed"}` on POST/PUT/DELETE/PATCH;
  - SELECT projects six columns: id, name, hindiName, baseLocation,
    expertiseAreas, pairingsActive;
  - mentorPairings JOIN filters to `status = "active"`;
  - audit row uses `action: "mentors.bulk_export"` and runs AFTER
    the SELECT (so rowCount is accurate);
  - response carries `Content-Type: text/csv` and
    `Content-Disposition: attachment; filename="mentors-...csv"`;
  - `apps/web/src/app/(authenticated)/repo/mentors/page.tsx` carries
    a `Download CSV` anchor with `data-testid="mentors-csv-export"`,
    pointed at `/api/admin/data/mentors/export`, gated on a `canExport`
    super_admin/programme_admin check.
  Run suite → red.
- [x] T2 → write the new GET handler at
  `apps/web/src/app/api/admin/data/mentors/export/route.ts`:
  auth gate (401), role gate (403), SELECT with the inline pairings
  join, audit row after the SELECT, Papa.unparse to CSV, attachment
  response.
  Run scoped governance test → handler assertions green.
- [x] T3 → add 405 method handlers (POST, PUT, DELETE, PATCH) on
  the same route file so the method matrix is complete.
  Run scoped governance test → method-matrix assertions green.
- [x] T4 → edit `apps/web/src/app/(authenticated)/repo/mentors/page.tsx`:
  derive `canExport` from `session.user.role`; wrap the heading
  column in a flex row alongside a `Download CSV` anchor that's
  rendered only when `canExport` is true.
  Run scoped governance test → page assertions green.
- [x] T5 → author all five spec-kit files under
  `specs/160-mentor-csv-export/`.
- [x] T6 → run the full governance suite. Confirm no regression.
  The route file is brand new; the page edit is additive (the existing
  h1/p/label markup is preserved, just wrapped in a flex).
- [ ] T7 (future, out of scope) → add a `?base=Leh|Kargil` filter
  parameter to the route so operators can narrow the export. The
  index page itself doesn't filter by base yet — wait until the page
  grows a base filter (spec 158 is name-search-only) before threading
  it through here.
- [ ] T8 (future, out of scope) → add a CSV import path for mentors.
  The generic admin grid already covers import via
  `apps/web/src/admin/registry.ts` → `mentorsEntity`. If operators
  start asking for a round-trip (export + edit + re-import) we'd
  need to make the export columns match the entity formSchema's
  required fields exactly. That's a follow-up — this spec is
  export-only.
- [ ] T9 (future, out of scope) → extract the route shape into a
  reusable `exportCsvWithJoin(entitySlug, joinSpec, columns)` helper.
  Three candidate sites today (mentors here, schools count-roll-up,
  teachers session-count). Below the threshold where the abstraction
  pays for itself; revisit when the pattern hits ~5 sites.
