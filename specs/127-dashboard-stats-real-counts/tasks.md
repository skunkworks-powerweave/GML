# Tasks 127

- [x] T1 → write governance test (red) covering the five chrome helpers, the per-role stat sets, the mentor 48h SLA filter, the open-quizzes NOT IN subquery, the FieldMap query, and the dashboard.viewed audit → run the suite → red.
- [x] T2 → rewrite `dashboard/page.tsx` getCounts into five React.cache-wrapped chrome helpers (programme / teacher / observer / mentor / field-map). Each helper runs its queries through Promise.all.
- [x] T3 → wire the role-variant render path so each role calls exactly one chrome helper and renders stats + todos from its return.
- [x] T4 → replace the hardcoded TodayChecklist rows with per-role todo builders that read the same chrome data + run small follow-up queries for "today" details (cycles awaiting sign-off, meetings today, etc).
- [x] T5 → render the FieldMap from a real `db.select` over the schools table, with a `<title>` per dot and a `/repo/school/[id]` link per dot. Gate visibility to super_admin + programme_admin.
- [x] T6 → fire a best-effort `dashboard.viewed` audit per render (role in metadata).
- [x] T7 → author all five spec-kit files under `specs/127-dashboard-stats-real-counts/`.
- [x] T8 → run `node --test tests/governance/test_127_*.test.mjs` → green.
- [ ] T9 (future) → swap the Q-progress-forms-due proxy for a real `feedback_responses` quarter-bound join when we add the materialised view that makes it cheap.
- [ ] T10 (future) → add `schools.lat` + `schools.lng` columns and reposition FieldMap dots from real coordinates instead of the code-hash schematic.
- [ ] T11 (future) → replace the `SUM(files.sizeBytes)` storage proxy with a real MinIO admin bucket-stats probe once the credential plumbing reaches the web boundary.
