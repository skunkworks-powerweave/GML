# Spec 152 — Admin grid improvements (Workflow Run 14 MEDIUM audit closure)

## Why

The 7-agent code audit at the close of Workflow Run 13 ran a MEDIUM-tier
sweep across the admin surface. Two findings consolidate here because they
both live in the no-code admin substrate that ships every entity (specs
012-019), and both are race-or-coerce bugs that hide in normal-development
traffic and only surface when a real programme_admin tries to filter a
non-string column or two of them PUT a feedback-form schema at the same time:

1. **`admin/data/[entity]/page.tsx` — blanket `ilike()` on every column.**
   Spec 114 shipped the column-filter toolbar with the comment
   "ilike for text columns, equality for the rest" but the code path
   actually pushed every column through `ilike(col, "%v%")` regardless of
   type. Drizzle's pg driver applies `LOWER(<col>)` for ilike — on an enum
   column (`status`, `kind`, `audience`) the cast fails and the route 500s;
   on a boolean (`active`) it silently coerces to a string compare against
   "true"/"false" with no enum guard; on a number (`grade`, `term`, `weeks`)
   it does a substring match on the text representation, which is correct
   for a digit-prefix but wrong for "1" matching "10", "11", "12", "21"…
   Five entities in `ADMIN_ENTITIES` carry at least one enum column
   (`course-outlines.status`, `mentor-pairings.status`,
   `rtt-attendance.status`, `resources.kind`, `sessions.status`),
   four carry numeric columns, and every entity carries at least one
   boolean. The bug shipped silent.

2. **`api/admin/forms/[id]/route.ts` — version-bump race.** PUT
   SELECT-then-bump-then-UPDATE without a lock. Two concurrent PUTs both
   read version "2", both compute "3", both write "3". The
   `feedback_forms_kind_audience_version_uq` unique index in
   `packages/db/src/schema/mentorship.ts` (kind, audience, version)
   catches it ONLY when the second PUT targets the same triple — but the
   route operates by id, so when the same kind/audience are split across
   two ids (a rare but real shape) the index never fires and both writes
   succeed at version "3", leaving an admin reviewing /admin/forms with
   two rows that look indistinguishable. The fix is the same shape as
   spec 148's gate-rotate: wrap in `db.transaction` and grab a row-level
   lock with `.for("update")`.

## What we ship

### `apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx` (EDITED)

- New helper `unwrapZod(zodType)` that peels `optional/nullable/default`
  wrappers off a Zod node and returns the inner type. Mirrors the
  helper inside `row-form.tsx::inferInputType` (spec 114) so the form
  surface and the filter surface read column types the same way.
- New helper `buildColumnFilter(zodType, col, value)` that dispatches by
  Zod type name:
  - `ZodString` → `ilike(col, "%v%")` (case-insensitive contains)
  - `ZodEnum`   → `eq(col, v)` only when `v` is in `enum.options`
  - `ZodBoolean`→ `eq(col, v === "true")`
  - `ZodNumber` → `eq(col, Number(v))` only when the cast is finite
  - anything else → returns `null`, dispatcher logs a dev-mode warn
- The filter loop now calls `buildColumnFilter(formShape[key], col, value)`
  and only appends to `whereClauses` when the return is non-null. Skipped
  keys are accumulated into a separate `skippedFilters` map that is folded
  into the SM-9 PII-audit row alongside `appliedFilters`, so the audit
  log still records the user's intent when a filter is silently dropped.
- The page imports `z` from `zod` so the helper can use `z.ZodTypeAny`.

### `apps/web/src/app/api/admin/forms/[id]/route.ts` (EDITED)

- The SELECT + UPDATE pair is wrapped in
  `db.transaction(async (tx) => { ... })`.
- The SELECT inside the tx uses `.for("update")` to acquire a row-level
  lock on the existing row. Postgres SELECT … FOR UPDATE blocks every
  other transaction trying to lock the same row until commit; two
  concurrent PUTs serialise so the second writer re-reads the
  freshly-bumped version and computes "3" → "4" instead of trampling.
- The transaction returns `{ prevVersion, nextVersion }` or `null` when
  the row is missing. The outer function converts the null into a 404
  and the resolved pair into the 200 response + audit metadata.
- The `recordAudit("form.schema.update")` call fires AFTER the
  transaction commits (same pattern as spec 148): the audit log only
  records successful version bumps, and an audit-write failure never
  rolls back a committed update.

## Acceptance criteria

- `page.tsx` declares `buildColumnFilter(zodType, col, value)`.
- `page.tsx` reads `entity.formSchema._def.shape()` into a `formShape`
  map keyed by field name.
- The filter loop calls `buildColumnFilter(formShape[key], col, value)`
  and appends to `whereClauses` only when the result is non-null.
- The blanket `ilike(col as never, ...)` call inside the filter loop
  (the pre-spec shape) is gone — it now lives only inside
  `buildColumnFilter` under the `ZodString` branch.
- `page.tsx` imports `z` from `zod`.
- The SM-9 audit metadata block includes `skippedFilters` alongside
  `filters`.
- `route.ts` wraps the SELECT + UPDATE in
  `db.transaction(async (tx) => { ... })`.
- The SELECT inside the tx uses `.for("update")`.
- `recordAudit` fires AFTER the transaction `})` closes.
- All five spec-kit files exist under `specs/152-admin-grid-improvements/`.
- `tests/governance/test_152_admin_grid_improvements.test.mjs` passes
  with at least eight assertions covering the above.

## Non-goals

- **No new dependencies.** Pure dispatch + transaction wrap. The same
  drizzle-orm + zod that already ship.
- **No schema change.** The race lives in the route, not the table.
  The unique index on (kind, audience, version) stays as a belt — the
  transaction is the suspenders.
- **No new filter UI types.** The toolbar still renders a single
  `<input>` per column. The dispatcher just sends the typed value to
  Postgres correctly. A future spec (out of scope here) could render
  a `<select>` for enum columns and a `<input type=checkbox>` for
  booleans, but that's a UX change, not a bug fix.
- **No retry on serialisation conflict.** Postgres in READ COMMITTED
  (the default) won't raise serialisation_failure for the FOR UPDATE
  path — the second writer just waits. If the deployment ever flips
  to SERIALIZABLE we'd add a one-shot retry on `40001`; not now.
- **No batched-import path.** CSV import (spec 022) doesn't go through
  the version-bump path; this spec only fixes the per-row PUT.
