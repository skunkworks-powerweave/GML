# Tasks 152

- [x] T1 → write the governance test (red) covering:
  - `page.tsx` declares `buildColumnFilter(zodType, col, value)`;
  - `page.tsx` reads `entity.formSchema._def.shape()` into a
    `formShape` map;
  - the filter loop calls `buildColumnFilter` and gates on a
    non-null return before appending to `whereClauses`;
  - the blanket `ilike(col as never, ...)` from spec 114's filter
    loop is removed (only present inside the new dispatcher's
    `ZodString` branch);
  - the SM-9 audit metadata block includes `skippedFilters`
    alongside `filters`;
  - `route.ts` wraps the SELECT + UPDATE in
    `db.transaction(async (tx) => { ... })`;
  - the SELECT inside the tx uses `.for("update")`;
  - `recordAudit` fires AFTER the closing `})` of the
    transaction callback.
  Run suite → red.
- [x] T2 → edit
  `apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx`:
  - add `unwrapZod` helper (peels optional/nullable/default
    wrappers) and `buildColumnFilter` dispatcher (ZodString →
    ilike, ZodEnum → eq with options-membership check, ZodBoolean
    → eq with "true" coercion, ZodNumber → eq with finite-number
    guard, anything else → null + dev-mode warn);
  - read `entity.formSchema._def.shape()` into `formShape`;
  - swap the inline `ilike(col as never, "%${value}%")` call inside
    the filter loop for `buildColumnFilter(formShape[key], col, value)`;
  - accumulate rejected keys into `skippedFilters`;
  - fold `skippedFilters` into the SM-9 PII-audit metadata block;
  - import `z` from `zod`.
  Run scoped governance test → dispatcher assertions green.
- [x] T3 → edit `apps/web/src/app/api/admin/forms/[id]/route.ts`:
  - wrap the SELECT + UPDATE pair in
    `db.transaction(async (tx) => { ... })`;
  - swap `db.select(...)` for `tx.select(...).for("update")` inside
    the tx;
  - swap `db.update(...)` for `tx.update(...)` inside the tx;
  - return the resolved `{ prevVersion, nextVersion }` (or `null`
    for not-found) from the tx callback;
  - move the `recordAudit` call to AFTER the transaction commits;
  - wrap the transaction in try/catch and convert a thrown
    transaction error into a 500 `transaction_failed` JSON
    response.
  Run scoped governance test → transaction assertions green.
- [x] T4 → author all five spec-kit files under
  `specs/152-admin-grid-improvements/`.
- [x] T5 → run the full governance suite. Confirm no regression
  on the 1197 pre-spec tests. The dispatcher edit is additive
  (text columns still go through ilike, just via a different
  call site), so existing spec-114 filter tests still pass. The
  transaction edit changes the internal call shape but preserves
  the response contract (200 with `{ ok, version }`, 404 for
  missing, 500 for thrown), so the spec-073 form route tests
  still pass.
- [ ] T6 (future, out of scope) → enum-typed filter UI. Render a
  `<select>` for `ZodEnum` columns and an `<input type=checkbox>`
  for `ZodBoolean` so the admin can't even type an invalid value
  in the first place. Currently the dispatcher silently drops
  invalid input; a friendlier UX would prevent it. Defer until
  the admin substrate gets its next UX pass.
- [ ] T7 (future, out of scope) → date / datetime filter range.
  `ZodDate` columns would benefit from a `from` + `to` pair of
  inputs that translate to `gte(col, from) AND lte(col, to)`.
  No current entity declares a `z.date()` column in `formSchema`
  (dates are derived columns the admin doesn't filter on), so
  this is a forward-looking placeholder.
- [ ] T8 (future, out of scope) → CSV-import version-bump audit.
  Spec 022's CSV import doesn't go through the per-row PUT, so
  this transaction fix doesn't touch it. If the import ever
  starts mutating versions a similar lock-on-the-existing-row
  pattern would apply.
