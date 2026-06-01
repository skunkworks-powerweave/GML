# Spec 114 — Admin grid mutations (edit + delete + filter)

**Status:** in_progress · **Date:** 2026-06-02 · **Constitution Check:** SM-1
reinforced — every new mutation routes through `withAudit()` with dotted-notation
action names. SM-9 untouched (learners role gates already enforced by
`mutateRoles` on the entity).

## Workflow Run 9 — frontend parity Tier A

The JSX prototype's `admin.jsx::AdminTable` (lines 86-220) shipped four
interactive affordances on the generic data grid:

1. **Create row** — already wired in spec 012 (`createRowAction`).
2. **Edit row** — JSX-only; production grid was read-only after create.
3. **Delete row** — JSX-only with a `ConfirmModal`; production grid had no
   delete button at all.
4. **Per-column filter UI** — JSX showed `<input>` fields in each column
   header; production grid had no filter affordance.

This spec closes parity items 2-4. Items 1 (create) and the CSV import/export
side door (specs 020/022) are explicitly untouched — we reuse them.

## FRs

- **FR-001**: `updateRowAction(prev, formData)` exists in
  `apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts`. Reads
  `entitySlug` + `rowId` + the entity's `formFields` from FormData; validates
  with `entity.formSchema`; calls `db.update(entity.table).set(parse.data).where(eq(idCol, rowId))`;
  routes through `withAudit({action: "admin.row.update", entityId: rowId})`.
  Returns `{ ok: true }` on success, otherwise `{ ok: false, error, fields,
  fieldErrors }` with per-field zod messages.
- **FR-002**: `createRowAction` migrated to the dotted-notation
  `"admin.row.create"` audit action (was the bare `"edit"` placeholder under
  spec 021 pre-rename).
- **FR-003**: `deleteRowAction` migrated to the dotted-notation
  `"admin.row.delete"` audit action and now requires a client-side confirm
  before firing (handled by `delete-button.tsx`, which mirrors
  `ux.jsx::ConfirmModal`).
- **FR-004**: `RowForm` accepts `mode="edit" | "create"`, `rowId`, and
  `initialValues`. In edit mode it dispatches to `updateRowAction`, renders
  prefilled inputs, surfaces field-level errors, and shows a Cancel link.
- **FR-005**: Per-row Edit link (`?edit=<rowId>`) on the data grid opens the
  edit form prefilled with the current row. The page server-component fetches
  the single row via `eq(idCol, editRowId)` and passes it to `RowForm`.
- **FR-006**: Per-row Delete button uses the new `DeleteRowButton` client
  component, which fires `window.confirm()` before posting `deleteRowAction`.
- **FR-007**: Column filter UI: a toolbar form below the grid header with one
  text input per `displayColumn`. Submitting issues a GET with
  `?filter[<col>]=<value>` query params; the page narrows the SELECT via
  `ilike(col, "%value%")` joined with `and(...)`. URL-driven for shareability.
  A "Clear" link strips the filters.
- **FR-008**: Pagination links preserve filters (`buildPageHref(page)` rebuilds
  the querystring including all active filters).
- **FR-009**: Role gate honored — all three actions call
  `requireRole(entity.mutateRoles ?? entity.readRoles)`. For `learners`,
  `mutateRoles = ["super_admin"]` (SM-9), so only super_admin can update or
  delete a learner row.
- **FR-010**: CSV import/export (`exportCsv`, `importCsv`) untouched — spec
  validation cross-checks the helpers + routes still exist.

## Acceptance criteria

- `pnpm test -- tests/governance/test_114_*` passes locally.
- Admin grid `/admin/data/schools` shows Edit + Delete buttons per row, and a
  filter toolbar above the table.
- `/admin/data/schools?edit=<id>` shows the row prefilled in the create form's
  position and submits to `updateRowAction`.
- `/admin/data/schools?filter[name]=foo` narrows the result set via ilike.
- Audit log gets an `admin.row.update`, `admin.row.delete`, or `admin.row.create`
  row after each respective mutation (verified by reading
  `audit_log.action`).
- CSV export still works (`/api/admin/data/schools/export` returns text/csv).
