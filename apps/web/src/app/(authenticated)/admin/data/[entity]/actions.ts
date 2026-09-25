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
import type { z } from "zod";
import { unwrapShape, coerceFormValues } from "@/admin/zod-shape";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db } from "@gml/db";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { entityRowProblems } from "@/admin/access";
import type { AdminDb } from "@/admin/types";
import { auditRowLabel, deleteImage, MutationRefused, updateAudit } from "@/admin/audit-image";
import { describeWriteError } from "@/admin/db-errors";
import { keepStoredPrecision } from "@/admin/dates";
import { requireRole } from "@/lib/guards";
import { assertSectionGate } from "@/lib/gates";
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

const BULK_BEFORE_IMAGE_CAP = 200;

function mutateRolesFor(entity: ReturnType<typeof getEntityOrThrow>) {
  return entity.mutateRoles ?? entity.readRoles;
}

/**
 * The section gate, after the role check. A server action runs before any
 * layout or page, so the grid page's own gate check never sees these
 * requests: each action has to make it. Redirects to the unlock page when the
 * grant is missing (admin/access.ts explains which entities are gated).
 */
async function requireEntityGate(entity: ReturnType<typeof getEntityOrThrow>, userId: string) {
  if (entity.gate) {
    await assertSectionGate(userId, entity.gate, `/admin/data/${entity.slug}`);
  }
}

/**
 * A database refusal as an action state: one sentence naming the field
 * (admin/db-errors.ts), never the driver's text. Create and update returned
 * `Insert failed: ${String(err)}` -- constraint and table names, to a page
 * programme_admin can reach -- which describeDbError below already refused
 * to do for deletes.
 */
function writeErrorState(
  entity: ReturnType<typeof getEntityOrThrow>,
  raw: Record<string, unknown>,
  err: unknown,
): AdminActionState {
  const message = describeWriteError(entity, err);
  const field = message.split(":")[0]!;
  return {
    ok: false,
    error: message,
    fields: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? "")])),
    ...(entity.formFields.includes(field) ? { fieldErrors: { [field]: message.slice(field.length + 2) } } : {}),
  };
}

/** Field errors from the entity's database-backed rules, as an action state. */
function problemsState(raw: Record<string, unknown>, problems: Record<string, string>): AdminActionState {
  const [field, message] = Object.entries(problems)[0]!;
  return {
    ok: false,
    error: `${field}: ${message}`,
    fields: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? "")])),
    fieldErrors: problems,
  };
}

/** Thrown inside the update's transaction when the entity's rules refuse the row. */
class RowProblems extends Error {
  constructor(readonly problems: Record<string, string>) {
    super(Object.entries(problems).map(([field, message]) => `${field}: ${message}`).join("; "));
  }
}

/**
 * Coerce raw FormData values into shapes Zod can validate.
 * Spec 114: extracted so create + update share identical coercion.
 */
function coerceFormData(
  formData: FormData,
  fields: readonly string[],
  // The schema's field map, so each value can be turned back into the TYPE the
  // schema expects. Without it every value stays a string, and an array field
  // is rejected with "Expected array, received string" -- which made mentors,
  // course-outlines and resources impossible to edit at all, including saving a
  // row without changing anything.
  shape: Record<string, z.ZodTypeAny>,
  // On UPDATE, an empty string is the user CLEARING a field and must reach the
  // database as null. On CREATE it is just an untouched input, and forwarding
  // null would override a column default, so it is still skipped there.
  //
  // Skipping it on update meant "delete the contents of an optional column and
  // press Save" silently kept the old value while the UI reported "Row
  // updated." -- the operator was told the write succeeded and shown the stale
  // value, with no way to tell the difference from a display bug.
  //
  // ...but only where the column takes null. A REQUIRED field emptied on
  // update is left out, so zod reports it; sending null to z.coerce.date()
  // produced new Date(0) and saved 1970-01-01 with "Row updated."
  opts: { emptyMeansNull?: boolean } = {},
): Record<string, unknown> {
  // The shared implementation (admin/zod-shape.ts), also used by CSV import.
  return coerceFormValues(
    fields,
    shape,
    (field) => {
      const value = formData.get(field);
      return typeof value === "string" ? value : null;
    },
    opts,
  );
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
  const session = await requireRole(mutateRolesFor(entity));
  await requireEntityGate(entity, session.user.id);

  const raw = coerceFormData(formData, entity.formFields, unwrapShape(entity.formSchema));
  const parse = entity.formSchema.safeParse(raw);
  if (!parse.success) {
    return shapeZodError(raw, parse.error.issues);
  }
  const problems = await entityRowProblems(entity, parse.data as Record<string, unknown>);
  if (problems) return problemsState(raw, problems);

  const audited = withAudit(
    async () => {
      // RETURNING the row so the audit entry carries its id (see withAudit).
      const inserted = db.insert(entity.table as never).values(parse.data as never) as unknown as {
        returning: () => Promise<Array<Record<string, unknown>>>;
      };
      const [created] = await inserted.returning();
      return created?.id != null ? String(created.id) : null;
    },
    {
      action: "admin.row.create",
      entityType: entity.slug,
      entityIdFrom: (id) => id,
      metadata: { op: "create", row: auditRowLabel(entity, parse.data as Record<string, unknown>) },
    },
  );

  try {
    await audited();
  } catch (err) {
    console.error("[admin.row.create] failed", err);
    return writeErrorState(entity, raw, err);
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
  const session = await requireRole(mutateRolesFor(entity));
  await requireEntityGate(entity, session.user.id);

  const raw = coerceFormData(formData, entity.formFields, unwrapShape(entity.formSchema), {
    emptyMeansNull: true,
  });
  const parse = entity.formSchema.safeParse(raw);
  if (!parse.success) {
    return shapeZodError(raw, parse.error.issues);
  }
  // READ, GUARD, WRITE, in one transaction. This used to be a blind UPDATE by
  // id: it could not enforce a rule that depends on the row's current state
  // (a signed-off observation cycle keeping its teacher -- see the entity's
  // guardMutation) and had no previous value to audit, so after an edit the
  // append-only log could not say what the record had been. The row is locked
  // FOR UPDATE so the guard judges the state the write actually replaces --
  // and so do the entity's database-backed rules, which used to run before
  // the read and so re-judged every stored value, changed or not (a cycle
  // whose observer had since been deactivated could not have its topic fixed).
  const next = parse.data as Record<string, unknown>;
  const audited = withAudit(
    async () =>
      db.transaction(async (tx) => {
        const idCol = (entity.table as unknown as { id: unknown }).id;
        const [before] = (await tx
          .select()
          .from(entity.table as never)
          .where(eq(idCol as never, rowId))
          .for("update")) as Record<string, unknown>[];
        if (!before) throw new MutationRefused("That row no longer exists.");
        // A timestamp the minute-precision form posted back unchanged keeps
        // its seconds (admin/dates.ts keepStoredPrecision).
        const write = keepStoredPrecision(before, next);
        const reason = entity.guardMutation?.("update", before, { ...before, ...write });
        if (reason) throw new MutationRefused(reason);
        const problems = await entityRowProblems(entity, next, before, tx as unknown as AdminDb);
        if (problems) throw new RowProblems(problems);
        await tx
          .update(entity.table as never)
          .set(write as never)
          .where(eq(idCol as never, rowId));
        return updateAudit(entity, before, write);
      }),
    {
      action: "admin.row.update",
      entityType: entity.slug,
      entityId: rowId,
      metadata: {
        op: "update",
        row: auditRowLabel(entity, next),
      },
      // `changes: { field: { from, to } }` -- field names only for PII.
      metadataFrom: (diff) => diff,
    },
  );

  try {
    await audited();
  } catch (err) {
    if (err instanceof MutationRefused) return { ok: false, error: err.message };
    if (err instanceof RowProblems) return problemsState(raw, err.problems);
    console.error("[admin.row.update] failed", err);
    return writeErrorState(entity, raw, err);
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
  const session = await requireRole(mutateRolesFor(entity));
  await requireEntityGate(entity, session.user.id);

  // Read, guard, delete -- the same shape as updateRowAction, and for the same
  // two reasons: a state-dependent rule (a signed-off cycle is not deletable)
  // and a before-image, since the audit row used to be literally
  // {"op":"delete"} and could not say what was removed or whom it was about.
  const audited = withAudit(
    async () =>
      db.transaction(async (tx) => {
        // Drizzle's loose `eq(table.id, value)` needs the `id` column to exist.
        // All admin-editable tables in v2 do (uuid pk).
        const idCol = (entity.table as unknown as { id: unknown }).id;
        const [before] = (await tx
          .select()
          .from(entity.table as never)
          .where(eq(idCol as never, rowId))
          .for("update")) as Record<string, unknown>[];
        if (!before) return null;
        const reason = entity.guardMutation?.("delete", before);
        if (reason) throw new MutationRefused(reason, rowId);
        await tx.delete(entity.table as never).where(eq(idCol as never, rowId));
        return before;
      }),
    {
      action: "admin.row.delete",
      entityType: entity.slug,
      entityId: rowId,
      metadata: { op: "delete" },
      metadataFrom: (before) =>
        before ? { row: auditRowLabel(entity, before), before: deleteImage(entity, before) } : { missing: true },
    },
  );

  // THE OPERATOR HAS TO BE TOLD. A delete blocked by a foreign key -- which is
  // the NORMAL outcome when a row is referenced, and the most common failure on
  // this surface -- used to be swallowed into console.error, after which the
  // page revalidated and re-rendered the row still sitting there. From the
  // operator's side the button simply did nothing, twice, three times, with no
  // message on screen and the explanation only in a container log they have no
  // reason to read.
  let deleteError: string | null = null;
  try {
    await audited();
  } catch (err) {
    console.error("[admin.row.delete] failed", err);
    deleteError = gridErrorQuery(err);
  }
  revalidatePath(`/admin/data/${slug}`);
  if (deleteError) {
    redirect(`/admin/data/${slug}?${deleteError}`);
  }
}

/**
 * Turn a driver error into one sentence an administrator can act on.
 *
 * Deliberately narrow: only the codes with a genuinely useful explanation are
 * translated, and everything else gets a generic line. The raw driver text is
 * never shown -- it carries table names, constraint names and connection
 * detail, and this page is reachable by programme_admin as well as super_admin.
 */
function describeDbError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "23503") {
    return "still_referenced";
  }
  if (code === "23505") {
    return "duplicate";
  }
  return "delete_failed";
}

/**
 * The grid's `?error=` query for a failed delete, plus `&ref=<table>` naming
 * WHAT still references the row when the database says so.
 *
 * Since migration 0031 a delete that used to cascade into learners, attendance,
 * meetings or submitted forms is refused instead, so "still referenced" is now
 * a common answer -- and "other records" gives the operator nothing to go and
 * look for. Postgres reports the referencing table on a 23503; only a bare
 * identifier is passed on, and the page shows the matching entity's label.
 */
function gridErrorQuery(err: unknown): string {
  // A guard's refusal: the ROW, not its sentence. The page used to print
  // `detail` from the URL as its red banner, so any link could put
  // attacker-chosen text ("Session expired, re-enter your password at ...")
  // on a trusted admin page. The page asks the entity's guard again instead.
  if (err instanceof MutationRefused) {
    const params = new URLSearchParams({ error: "locked" });
    if (err.rowId) params.set("row", err.rowId);
    return params.toString();
  }
  const params = new URLSearchParams({ error: describeDbError(err) });
  const { code, table } = (err ?? {}) as { code?: string; table?: string };
  if (code === "23503" && table && /^[a-z_]+$/.test(table)) params.set("ref", table);
  return params.toString();
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
  const session = await requireRole(mutateRolesFor(entity));
  await requireEntityGate(entity, session.user.id);

  const idCol = (entity.table as unknown as { id: unknown }).id;
  let deletedCount = 0;
  let befores: Record<string, unknown>[] = [];

  try {
    await db.transaction(async (tx) => {
      // The same guard as the single-row delete, for EVERY selected row, and
      // the whole batch is refused if any one is refused -- otherwise the bulk
      // toolbar would be the way round it.
      befores = (await tx
        .select()
        .from(entity.table as never)
        .where(inArray(idCol as never, rowIds as never[]))
        .for("update")) as Record<string, unknown>[];
      for (const before of befores) {
        const reason = entity.guardMutation?.("delete", before);
        if (reason) throw new MutationRefused(reason, String(before.id));
      }
      // Single DELETE ... WHERE id IN (...) — atomic, one round-trip.
      // Drizzle's `inArray` builds the correct parameterised SQL list.
      await tx
        .delete(entity.table as never)
        .where(inArray(idCol as never, rowIds as never[]));
      deletedCount = befores.length;
    });
  } catch (err) {
    // Same reasoning as deleteRowAction: an atomic bulk delete that rolls back
    // because ONE of the selected rows is referenced looked identical to a
    // successful one, except that all N rows were still on screen afterwards.
    console.error("[admin.row.bulk_delete] transaction failed", err);
    revalidatePath(`/admin/data/${slug}`);
    redirect(`/admin/data/${slug}?${gridErrorQuery(err)}`);
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
      // What was removed, as for a single delete. A grid page selects at most
      // 50 rows; the cap only guards a hand-built request.
      before: befores.slice(0, BULK_BEFORE_IMAGE_CAP).map((b) => deleteImage(entity, b)),
      ...(befores.length > BULK_BEFORE_IMAGE_CAP ? { beforeTruncated: true } : {}),
    },
  });

  revalidatePath(`/admin/data/${slug}`);
}
