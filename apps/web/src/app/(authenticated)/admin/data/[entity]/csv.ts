// CSV import/export for the generic admin grid.
// Export: streams rows as text/csv with displayColumns as headers.
// Import: parses CSV, validates each row via entity.formSchema, batch-inserts via withAudit.

import "server-only";
import Papa from "papaparse";
import { db } from "@gml/db";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { exportColumnKeys } from "@/admin/export-columns";
import { requireRole } from "@/lib/guards";
import { withAudit } from "@/lib/audit";

function getEntityOrThrow(slug: string) {
  const e = ADMIN_ENTITIES[slug];
  if (!e) throw new Error(`Unknown admin entity: ${slug}`);
  return e;
}

function mutateRolesFor(entity: ReturnType<typeof getEntityOrThrow>) {
  return entity.mutateRoles ?? entity.readRoles;
}

/**
 * Export entity rows as CSV. Returns a Response with text/csv body suitable
 * for a download link. SM-9: learners.bulk_export is recorded by the caller route.
 */
/**
 * Row ceiling for a CSV download.
 *
 * 50,000 rows of the widest entity here is a few tens of megabytes -- large,
 * but survivable in one request. Beyond that the answer is a paginated export
 * or a direct database query, not a bigger number.
 */
export const EXPORT_ROW_LIMIT = 50_000;

export async function exportCsv(slug: string): Promise<Response> {
  const entity = getEntityOrThrow(slug);
  await requireRole(entity.readRoles);

  // Audit bulk export — special action for SM-9 PII-bearing entities.
  // For non-PII entities, the action is `<slug>.bulk_export`.
  if (entity.piiAudited && entity.slug === "learners") {
    // Require super_admin specifically for learners CSV per SM-9 docs.
    await requireRole(["super_admin"]);
  }

  // BOUNDED. This read the entire table with no LIMIT and then materialised the
  // whole CSV as a second copy in heap. On `learners` -- the largest table and
  // the one carrying children's names, ages and guardian details -- that is two
  // full copies of the most sensitive data in the system resident at once, on a
  // box sized for 8 GiB total, triggered by one click from any administrator.
  //
  // The cap is not a limitation of the export so much as an admission that a
  // browser download is the wrong shape for an unbounded table. A truncated
  // export is dangerous in a different way -- someone analyses it believing it
  // is complete -- so the response says so explicitly in a header AND in a
  // final CSV row, because whoever opens the file in Excel will not see headers.
  const rows = (await db
    .select()
    .from(entity.table as never)
    .limit(EXPORT_ROW_LIMIT + 1)) as Record<string, unknown>[];

  const truncated = rows.length > EXPORT_ROW_LIMIT;
  if (truncated) rows.length = EXPORT_ROW_LIMIT;

  // `id` first, then the entity's displayColumns. Without the id a parent's
  // export gave the operator nothing to paste into a child CSV's schoolId /
  // classId column -- see admin/export-columns.ts.
  const headers = exportColumnKeys(entity);
  const data = rows.map((r) => {
    const out: Record<string, string> = {};
    for (const k of headers) {
      const v = r[k];
      if (v === null || v === undefined) out[k] = "";
      else if (v instanceof Date) out[k] = v.toISOString();
      else if (typeof v === "object") out[k] = JSON.stringify(v);
      else out[k] = String(v);
    }
    return out;
  });

  if (truncated) {
    // A row inside the file itself. A header is invisible to anyone who opens
    // the download in a spreadsheet, which is everyone.
    const marker: Record<string, string> = {};
    for (const k of headers) marker[k] = "";
    marker[headers[0] ?? "id"] =
      `*** TRUNCATED at ${EXPORT_ROW_LIMIT} rows — this export is INCOMPLETE ***`;
    data.push(marker);
  }

  const csv = Papa.unparse({ fields: headers, data });
  const filename = `${entity.slug}-${new Date().toISOString().slice(0, 10)}.csv`;

  // Fire-and-forget audit row.
  const audited = withAudit(async () => {}, {
    action: `${entity.slug}.bulk_export`,
    entityType: entity.slug,
    metadata: { rowCount: rows.length, filename, truncated },
  });
  void audited();

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // For any programmatic caller. The in-file marker row is for the human
      // who opens it in a spreadsheet and never sees a header.
      ...(truncated ? { "X-Export-Truncated": String(EXPORT_ROW_LIMIT) } : {}),
    },
  });
}

/**
 * Import CSV — parses raw CSV string, validates rows via formSchema, bulk-inserts.
 * Returns a summary: { ok, inserted, skipped, errors }.
 */
export async function importCsv(slug: string, csv: string): Promise<{
  ok: boolean;
  inserted: number;
  skipped: number;
  errors: { row: number; message: string }[];
}> {
  const entity = getEntityOrThrow(slug);
  await requireRole(mutateRolesFor(entity));

  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      inserted: 0,
      skipped: parsed.data.length,
      errors: parsed.errors.map((e) => ({ row: e.row ?? -1, message: e.message })),
    };
  }

  const errors: { row: number; message: string }[] = [];
  const validRows: unknown[] = [];

  for (const [i, raw] of parsed.data.entries()) {
    // Coerce common scalar shapes; Zod schemas handle the strict validation.
    const coerced: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "" || v == null) continue;
      if (v === "true") coerced[k] = true;
      else if (v === "false") coerced[k] = false;
      else coerced[k] = v;
    }
    const parse = entity.formSchema.safeParse(coerced);
    if (!parse.success) {
      const issue = parse.error.issues[0];
      errors.push({ row: i + 2, message: `${issue?.path.join(".") ?? "row"}: ${issue?.message ?? "invalid"}` });
      continue;
    }
    validRows.push(parse.data);
  }

  if (validRows.length === 0) {
    return { ok: errors.length === 0, inserted: 0, skipped: parsed.data.length, errors };
  }

  const audited = withAudit(
    async () => {
      await db.insert(entity.table as never).values(validRows as never);
    },
    {
      action: `${entity.slug}.bulk_import`,
      entityType: entity.slug,
      metadata: { inserted: validRows.length, skipped: errors.length },
    },
  );

  try {
    await audited();
  } catch (err) {
    return {
      ok: false,
      inserted: 0,
      skipped: parsed.data.length,
      errors: [{ row: -1, message: `bulk_insert failed: ${String(err)}` }],
    };
  }

  return { ok: errors.length === 0, inserted: validRows.length, skipped: errors.length, errors };
}
