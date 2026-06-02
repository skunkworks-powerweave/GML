# Tasks 129

- [x] T1 → write governance test (red) covering each affected page's WHERE shape, searchParams typing, count aggregate, and the absence of the prior `rows.filter(...)` pattern → run the suite → red.
- [x] T2 → edit `/observation/page.tsx` — port the JSX filter strip, validate searchParams against the status / kind enum allow-lists, build `and(eq(...))` WHERE.
- [x] T3 → edit `/repo/schools/page.tsx` — remove the `matchesDistrict` in-memory filter, push `ilike(districts.code, …)` into the WHERE, do counts via GROUP BY.
- [x] T4 → edit `/repo/subjects/page.tsx` — add the `?grade=N` URL filter via a GET form + `or(isNull, lte/gte)` WHERE.
- [x] T5 → edit `/repo/outlines/page.tsx` — add grade + term + status filters via a GET form with three `<select>`s.
- [x] T6 → edit `/repo/sessions/page.tsx` — promote the existing client-side `.filter(...)` to a SQL WHERE; add `?from=` + `?to=` date range to the same form.
- [x] T7 → edit `/repo/teachers/page.tsx` — add `?school=` + `?phase=` UUID-validated filters via a GET form seeded from schools + phases.
- [x] T8 → edit `/videos/page.tsx` — promote the client-side `.filter(...)` to SQL; add `?source=` filter via a GET form alongside the status chips.
- [x] T9 → edit `/mentorship/page.tsx` — add a `?status=` URL filter with chip strip + per-status count aggregate.
- [x] T10 → author all five spec-kit files under `specs/129-server-side-filters-everywhere/`.
- [x] T11 → run `pnpm test -- --grep "spec 129"` and confirm green.
- [ ] T12 (future) → fold `?page=N` pagination into the same searchParams envelope for `/repo/sessions`, `/repo/teachers`, `/videos` (deferred — current `limit(200)` is fine for v1 dataset).
