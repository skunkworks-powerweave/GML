"use server";

// Generic admin CRUD server actions for any registered admin entity.
//
// SM-1 enforcement: every mutation goes through withAudit() so a row lands in
// audit_log. The grep gate in tests/governance/test_011_substrate_moats.test.mjs
// confirms this file references withAudit.
//
// Spec 114 (admin-grid-mutations) — extends the original v1 create/delete with
// an updateRowAction. All three now emit dotted-notation audit actions
// (`admin.row.create`, `admin.row.update`, `admin.row.delete`) per the
// SM-1 + spec 021 convention.

import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { db } from "@gml/db";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { requireRole } from "@/lib/guards";
import { recordAudit, withAudit } from "@/lib/audit";

export type AdminActionState = {
  ok?: boolean;
  error?: string;
  fields?: Record<string, string>;
  /** Field-level zod errors (spec 114): `{ fieldName: "must be uuid" }`. */
  fieldErrors?: Record<string, string>;
};

function getEntityOrThrow(slug: string) {
  const entity = ADMIN_ENTITIES[slug];
  if (!entity) throw new Error(`Unknown admin entity: ${slug}`);
  return entity;
}

function mutateRolesFor(entity: ReturnType<typeof getEntityOrThrow>) {
  return entity.mutateRoles ?? entity.readRoles;
}

/**
 * Coerce raw FormData values into shapes Zod can validate.
 * Spec 114: extracted so create + update share identical coercion.
 */
function coerceFormData(formData: FormData, fields: readonly string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const field of fields) {
    const value = formData.get(field);
    if (value === null) continue;
    if (typeof value === "string") {
      if (value === "") continue;
      if (value === "true") raw[field] = true;
      else if (value === "false") raw[field] = false;
      else raw[field] = value;
    } else {
      raw[field] = value;
    }
  }
  return raw;
}

/**
 * Build `fieldErrors` + summary `error` from a Zod safeParse failure.
 * Spec 114: surfaces per-field error messages for inline form display.
 */
function shapeZodError(
  raw: Record<string, unknown>,
  issues: { path: (string | number)[]; message: string }[],
): AdminActionState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const k = String(issue.path[0] ?? "_root");
    if (!fieldErrors[k]) fieldErrors[k] = issue.message;
  }
  const first = issues[0];
  return {
    ok: false,
    error: first ? `${first.path.join(".")}: ${first.message}` : "Validation failed",
    fields: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? "")])),
    fieldErrors,
  };
}

/**
 * Server action: create a new row.
 *
 * Form must include `entitySlug` plus the entity's `formFields` as string values.
 * Zod validates against `entity.formSchema`. Successful insert writes an audit row
 * with action "admin.row.create" (spec 114 dotted-notation convention).
 */
export async function createRowAction(
  _prev: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const slug = String(formData.get("entitySlug") ?? "");
  const entity = getEntityOrThrow(slug);
  await requireRole(mutateRolesFor(entity));

  const raw = coerceFormData(formData, entity.formFields);
  const parse = entity.formSchema.safeParse(raw);
  if (!parse.success) {
    return shapeZodError(raw, parse.error.issues);
  }

  const audited = withAudit(
    async () => {
      await db.insert(entity.table as never).values(parse.data as never);
    },
    {
      action: "admin.row.create",
      entityType: entity.slug,
      metadata: { op: "create", row: entity.describeRow?.(parse.data as Record<string, unknown>) },
    },
  );

  try {
    await audited();
  } catch (err) {
    return { ok: false, error: `Insert failed: ${String(err)}` };
  }

  revalidatePath(`/admin/data/${slug}`);
  return { ok: true };
}

/**
 * Server action: update an existing row by id.
 *
 * Spec 114 — admin grid edit-mode write path. Form must include `entitySlug`,
 * `rowId`, and the entity's `formFields`. Zod validates against `entity.formSchema`
 * (partial-aware via the same schema — Zod's `default()` and `optional()` make
 * missing fields safe). On success, emits "admin.row.update".
 */
export async function updateRowAction(
  _prev: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const slug = String(formData.get("entitySlug") ?? "");
  const rowId = String(formData.get("rowId") ?? "");
  if (!rowId) {
    return { ok: false, error: "Missing rowId" };
  }
  const entity = getEntityOrThrow(slug);
  await requireRole(mutateRolesFor(entity));

  const raw = coerceFormData(formData, entity.formFields);
  const parse = entity.formSchema.safeParse(raw);
  if (!parse.success) {
    return shapeZodError(raw, parse.error.issues);
  }

  const audited = withAudit(
    async () => {
      const idCol = (entity.table as unknown as { id: unknown }).id;
      await db
        .update(entity.table as never)
        .set(parse.data as never)
        .where(eq(idCol as never, rowId));
    },
    {
      action: "admin.row.update",
      entityType: entity.slug,
      entityId: rowId,
      metadata: {
        op: "update",
        row: entity.describeRow?.(parse.data as Record<string, unknown>),
      },
    },
  );

  try {
    await audited();
  } catch (err) {
    return { ok: false, error: `Update failed: ${String(err)}` };
  }

  revalidatePath(`/admin/data/${slug}`);
  return { ok: true };
}

/**
 * Server action: delete a row by id.
 *
 * Spec 114 — dotted-notation audit action "admin.row.delete". Confirmation UI
 * (ConfirmModal mirroring the JSX prototype) is enforced client-side in
 * page.tsx via the `data-confirm` attribute pattern.
 */
export async function deleteRowAction(formData: FormData): Promise<void> {
  const slug = String(formData.get("entitySlug") ?? "");
  const rowId = String(formData.get("rowId") ?? "");
  if (!slug || !rowId) return;

  const entity = getEntityOrThrow(slug);
  await requireRole(mutateRolesFor(entity));

  const audited = withAudit(
    async () => {
      // Drizzle's loose `eq(table.id, value)` needs the `id` column to exist.
      // All admin-editable tables in v2 do (uuid pk).
      const idCol = (entity.table as unknown as { id: unknown }).id;
      await db.delete(entity.table as never).where(eq(idCol as never, rowId));
    },
    {
      action: "admin.row.delete",
      entityType: entity.slug,
      entityId: rowId,
      metadata: { op: "delete" },
    },
  );

  try {
    await audited();
  } catch (err) {
    console.error("[admin.row.delete] failed", err);
  }
  revalidatePath(`/admin/data/${slug}`);
}

/**
 * Server action: bulk-delete N rows in a single transaction.
 *
 * Spec 157 — admin grid bulk select + delete. The client toolbar
 * (bulk-toolbar.tsx::BulkDeleteToolbar) appends every selected rowId to the
 * FormData under the repeated key "rowIds", then posts here. We:
 *
 *   1. Role-gate identically to deleteRowAction (mutateRolesFor(entity)).
 *   2. Run DELETE ... WHERE id IN (...) inside `db.transaction(...)` so
 *      either every row is deleted or none are.
 *   3. Audit "admin.row.bulk_delete" AFTER the transaction commits (same
 *      commit-then-audit shape as spec 148 / spec 152). Metadata carries
 *      the count and the first ≤5 ids — enough to investigate the action
 *      from the audit log without leaking a 200-id payload.
 *
 * Re-uses recordAudit() rather than withAudit() because withAudit() wraps a
 * single op with implicit success/failure logging; we want the audit row to
 * land only on commit (the bulk op is atomic, so a failure halfway through
 * rolls everything back and there's no inconsistent state to audit).
 */
export async function bulkDeleteAction(formData: FormData): Promise<void> {
  const slug = String(formData.get("entitySlug") ?? "");
  const rowIds = formData.getAll("rowIds").map(String).filter(Boolean);
  if (!slug || rowIds.length === 0) return;

  const entity = getEntityOrThrow(slug);
  await requireRole(mutateRolesFor(entity));

  const idCol = (entity.table as unknown as { id: unknown }).id;
  let deletedCount = 0;

  try {
    await db.transaction(async (tx) => {
      // Single DELETE ... WHERE id IN (...) — atomic, one round-trip.
      // Drizzle's `inArray` builds the correct parameterised SQL list.
      await tx
        .delete(entity.table as never)
        .where(inArray(idCol as never, rowIds as never[]));
      deletedCount = rowIds.length;
    });
  } catch (err) {
    console.error("[admin.row.bulk_delete] transaction failed", err);
    return;
  }

  // Commit-then-audit. The audit row lands only on a successful commit —
  // a tx rollback never leaves a phantom audit entry.
  void recordAudit({
    action: "admin.row.bulk_delete",
    entityType: entity.slug,
    metadata: {
      op: "bulk_delete",
      count: deletedCount,
      // First 5 ids for traceability. A full N-id dump can blow the metadata
      // JSON column on big selections; 5 is enough to spot-check.
      ids: rowIds.slice(0, 5),
    },
  });

  revalidatePath(`/admin/data/${slug}`);
}
