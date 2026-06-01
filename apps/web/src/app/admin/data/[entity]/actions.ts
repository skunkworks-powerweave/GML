"use server";

// Generic admin CRUD server actions for any registered admin entity.
//
// SM-1 enforcement: every mutation goes through withAudit() so a row lands in
// audit_log. The grep gate in tests/governance/test_011_substrate_moats.test.mjs
// confirms this file references withAudit.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { requireRole } from "@/lib/guards";
import { withAudit } from "@/lib/audit";

export type AdminActionState = {
  ok?: boolean;
  error?: string;
  fields?: Record<string, string>;
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
 * Server action: create a new row.
 *
 * Form must include `entitySlug` plus the entity's `formFields` as string values.
 * Zod validates against `entity.formSchema`. Successful insert writes an audit row.
 */
export async function createRowAction(
  _prev: AdminActionState | undefined,
  formData: FormData,
): Promise<AdminActionState> {
  const slug = String(formData.get("entitySlug") ?? "");
  const entity = getEntityOrThrow(slug);
  await requireRole(mutateRolesFor(entity));

  const raw: Record<string, unknown> = {};
  for (const field of entity.formFields) {
    const value = formData.get(field);
    if (value === null) continue;
    if (typeof value === "string") {
      // Cheap coercion: empty string → undefined; "true"/"false" → boolean.
      if (value === "") continue;
      if (value === "true") raw[field] = true;
      else if (value === "false") raw[field] = false;
      else raw[field] = value;
    } else {
      raw[field] = value;
    }
  }

  const parse = entity.formSchema.safeParse(raw);
  if (!parse.success) {
    const issue = parse.error.issues[0];
    return {
      ok: false,
      error: issue ? `${issue.path.join(".")}: ${issue.message}` : "Validation failed",
      fields: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? "")])),
    };
  }

  const audited = withAudit(
    async () => {
      await db.insert(entity.table as never).values(parse.data as never);
    },
    {
      action: "edit",
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
 * Server action: delete a row by id.
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
      action: "delete",
      entityType: entity.slug,
      entityId: rowId,
      metadata: { op: "delete" },
    },
  );

  try {
    await audited();
  } catch (err) {
    console.error("[admin.delete] failed", err);
  }
  revalidatePath(`/admin/data/${slug}`);
}
