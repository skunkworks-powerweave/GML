// CSV import/export for the generic admin grid.
// Export: streams rows as text/csv with displayColumns as headers.
// Import: parses CSV, validates each row via entity.formSchema, batch-inserts via withAudit.

import "server-only";
import Papa from "papaparse";
import { db } from "@gml/db";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { exportColumnKeys } from "@/admin/export-columns";
import { entityRowProblems, exportRolesFor } from "@/admin/access";
import { CSV_EXPORT_OPTIONS, unescapeFormulaCell } from "@/admin/csv-safety";
import { describeWriteError } from "@/admin/db-errors";
import { coerceFormValues, unwrapShape } from "@/admin/zod-shape";
import { requireRole } from "@/lib/guards";
import { withAudit } from "@/lib/audit";

/**
 * Bind parameters per INSERT statement. Postgres' wire protocol allows
 * 65,535; staying well under leaves room for the columns Drizzle adds.
 */
const IMPORT_PARAMETER_BUDGET = 60_000;

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
  // Administrators among the readers only; see admin/access.ts exportRolesFor.
  await requireRole(exportRolesFor(entity));

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

  const csv = Papa.unparse({ fields: headers, data }, CSV_EXPORT_OPTIONS);
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
      // Papa's `row` is the 0-based data row; the operator's spreadsheet line
      // is that + 2 (the header is line 1), the same numbering as below.
      errors: parsed.errors.map((e) => ({ row: e.row != null ? e.row + 2 : -1, message: e.message })),
    };
  }

  const errors: { row: number; message: string }[] = [];
  // Each valid row keeps its spreadsheet line, so a refusal from the database
  // can be reported against it.
  const validRows: Array<{ line: number; data: Record<string, unknown> }> = [];
  const shape = unwrapShape(entity.formSchema);

  for (const [i, raw] of parsed.data.entries()) {
    const line = i + 2; // header is line 1
    // The SAME coercion as the grid's form (admin/zod-shape.ts). importCsv
    // used to keep its own, which knew only lowercase true/false: array
    // columns (expertiseAreas, tags) were "Expected array, received string"
    // in every format, Excel's TRUE/FALSE was rejected, and dates went
    // through JS Date guessing (05/10/2026 read as 10 May). An empty cell is
    // an untouched field, as on create. Cells are un-escaped first
    // (admin/csv-safety.ts), so an edited export imports as it was.
    const coerced = coerceFormValues(entity.formFields, shape, (field) => {
      const cell = raw[field];
      return typeof cell === "string" && cell !== "" ? unescapeFormulaCell(cell) : null;
    });
    const parse = entity.formSchema.safeParse(coerced);
    if (!parse.success) {
      const issue = parse.error.issues[0];
      errors.push({ row: line, message: `${issue?.path.join(".") ?? "row"}: ${issue?.message ?? "invalid"}` });
      continue;
    }
    // The entity's database-backed rules, which the grid's form enforces too
    // (a cycle's observer must be a live observer account).
    const problems = await entityRowProblems(entity, parse.data as Record<string, unknown>);
    if (problems) {
      const [field, message] = Object.entries(problems)[0]!;
      errors.push({ row: line, message: `${field}: ${message}` });
      continue;
    }
    validRows.push({ line, data: parse.data as Record<string, unknown> });
  }

  if (validRows.length === 0) {
    return { ok: errors.length === 0, inserted: 0, skipped: parsed.data.length, errors };
  }

  // ROW BY ROW, IN CHUNKS, IN ONE TRANSACTION.
  //
  // This was ONE multi-row INSERT for the whole file. So a single duplicate
  // code or unknown parent id aborted every row -- contradicting the panel's
  // "rows that fail are reported and skipped, and the rest still land" -- and
  // the result replaced the per-row validation errors with one
  // "bulk_insert failed: <raw driver text>" at row -1. And a statement is
  // limited to 65,535 bind parameters, so any file over rows x columns of
  // that (about 6,500 learners) always failed with "bind message has N
  // parameter formats but 0 parameters".
  //
  // Now each chunk stays under the parameter limit and runs in its own
  // savepoint; a chunk the database refuses is retried row by row, each in
  // its own savepoint, so exactly the offending rows are reported -- by line,
  // in words (admin/db-errors.ts) -- and every other row lands.
  const perRow = entity.formFields.length + 1;
  const chunkSize = Math.max(1, Math.floor(IMPORT_PARAMETER_BUDGET / perRow));
  const errorsBefore = errors.length;

  const audited = withAudit(
    async () =>
      db.transaction(async (tx) => {
        let inserted = 0;
        for (let start = 0; start < validRows.length; start += chunkSize) {
          const chunk = validRows.slice(start, start + chunkSize);
          try {
            await tx.transaction(async (sp) => {
              await sp.insert(entity.table as never).values(chunk.map((r) => r.data) as never);
            });
            inserted += chunk.length;
            continue;
          } catch {
            // Fall through: find the rows the database refuses.
          }
          for (const row of chunk) {
            try {
              await tx.transaction(async (sp) => {
                await sp.insert(entity.table as never).values(row.data as never);
              });
              inserted += 1;
            } catch (err) {
              errors.push({ row: row.line, message: describeWriteError(entity, err) });
            }
          }
        }
        return inserted;
      }),
    {
      action: `${entity.slug}.bulk_import`,
      entityType: entity.slug,
      metadata: {},
      metadataFrom: (inserted) => ({ inserted, skipped: parsed.data.length - inserted }),
    },
  );

  let inserted: number;
  try {
    inserted = await audited();
  } catch (err) {
    // Not a row's fault (the connection, the transaction itself): nothing
    // was committed. The driver text goes to the log, not the operator.
    console.error(`[${entity.slug}.bulk_import] failed`, err);
    return {
      ok: false,
      inserted: 0,
      skipped: parsed.data.length,
      errors: [...errors.slice(0, errorsBefore), { row: -1, message: "The import could not be completed. Nothing was saved." }],
    };
  }

  errors.sort((a, b) => a.row - b.row);
  return { ok: errors.length === 0, inserted, skipped: parsed.data.length - inserted, errors };
}
