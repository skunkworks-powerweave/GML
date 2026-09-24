// Generic no-code admin grid. Renders any entity registered in ADMIN_ENTITIES.
// Server component — reads via Drizzle, gates by role, renders the table.
// Mutations live in actions.ts; the row form is row-form.tsx.
//
// SM-1 reminder: every mutation goes through withAudit() in actions.ts.
//
// Spec 114 (admin-grid-mutations) — adds:
//   • Edit row: ?edit=<rowId> swaps the create form for the edit form,
//     loaded with the row's current values. Uses updateRowAction.
//   • Delete row: client-side confirm via DeleteRowButton before posting
//     deleteRowAction (audit "admin.row.delete").
//   • Column filter UI: per-column inputs in a toolbar form that narrow the
//     grid via ?filter[<column>]=<value>. URL-driven so filters are
//     shareable / bookmarkable, ilike for text columns, equality for the
//     rest. The toolbar mirrors admin.jsx::AdminTable lines 111-114.
//
// Spec 152 (admin-grid-improvements, Workflow Run 14 MEDIUM audit closure) —
// the previous shipped filter pushed every column through ilike() including
// enums, booleans and numbers. Drizzle's pg driver may throw or coerce
// unsafely when ilike is applied to a non-text column. The fix is a
// column-type aware filter dispatcher that reads the column's Zod schema
// from `entity.formSchema._def.shape()`: ZodString → ilike (case-insensitive
// contains); ZodEnum → eq() after validating the value is in the enum;
// ZodBoolean → eq() with a true/"true" coercion; ZodNumber → eq() with a
// finite-number guard; unknown / unsupported → skip silently. The skipped
// filters are logged in `appliedFilters._skipped` so the audit-trail of a
// PII-audited entity (SM-9) still records the user's intent.
//
// Spec 157 (admin-grid-sort-and-bulk-delete, Workflow Run 15 MISS closure) —
// adds two features the JSX prototype carried but the v1 grid missed:
//   (1) Sortable columns. URL-driven `?sort=<col>&dir=<asc|desc>`. Whitelist
//       the sortable column to `entity.displayColumns[].key` so a user
//       cannot inject SQL via the search param. Default sort is
//       `createdAt DESC` when the table has that column, falling back to
//       `id ASC`. Each <th> header becomes a button that navigates to the
//       same page with the new sort params.
//   (2) Bulk row select + delete. A leftmost checkbox column per row plus a
//       header "select all" checkbox feed a small client island
//       (bulk-toolbar.tsx::BulkSelectionProvider). A sticky toolbar above
//       the table renders "Delete N selected" when ≥1 row is checked. The
//       server action `bulkDeleteAction` runs DELETE in a single transaction
//       and audits `admin.row.bulk_delete` with count + ids[0..5] in metadata.
//   Sort + bulk delete are role-gated identically to the existing single-row
//   delete (entity.mutateRoles via mutateRolesFor in actions.ts).

import { notFound } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, getTableName, ilike, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { requireRole } from "@/lib/guards";
import { assertSectionGate } from "@/lib/gates";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";
import { getDeviceType } from "@/lib/device";
import { MobileEntityCardList } from "@/admin/components/MobileEntityCardList";
import { referenceLabels, referenceOptions } from "@/admin/references";
import { exportRolesFor } from "@/admin/access";
import { RowForm } from "./row-form";
import { DeleteRowButton } from "./delete-button";
import { ImportCsv } from "./import-csv";
import {
  BulkDeleteToolbar,
  BulkRowCheckbox,
  BulkSelectAllCheckbox,
  BulkSelectionProvider,
} from "./bulk-toolbar";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ entity: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PAGE_SIZE = 50;

/**
 * Parse `?filter[<key>]=<value>` style query params into a plain object.
 * Next.js flattens bracket-notation into keys like "filter[name]"; we accept
 * both that form and the JSON-shorthand `?filters=<base64-json>` (not used yet
 * but reserved for a future "save filter set" affordance).
 */
function extractFilters(
  sp: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const m = /^filter\[(.+)\]$/.exec(k);
    if (!m) continue;
    const key = m[1];
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw === "string" && raw.trim() !== "") out[key] = raw.trim();
  }
  return out;
}

/**
 * Spec 152 — peel optional/nullable/default wrappers off a Zod node so we can
 * read the inner type name. Mirrors `row-form.tsx::inferInputType` (spec 114).
 */
function unwrapZod(zodType: z.ZodTypeAny): z.ZodTypeAny {
  let inner: z.ZodTypeAny = zodType;
  const peek = (z: z.ZodTypeAny) =>
    z as unknown as { _def?: { innerType?: z.ZodTypeAny } };
  while (peek(inner)._def?.innerType) inner = peek(inner)._def!.innerType!;
  return inner;
}

/**
 * Spec 152 — column-type-aware filter dispatcher.
 *
 * The previous shipped code pushed every column's value through
 * `ilike(col, "%v%")`. Drizzle's pg driver applies LOWER() to the column
 * for ilike() — on an enum, boolean or numeric column the cast fails and
 * the whole page renders an Error Boundary. The fix below reads the
 * column's Zod type from `entity.formSchema._def.shape()` and dispatches:
 *
 *   - ZodString  → ilike(col, "%v%") (case-insensitive contains)
 *   - ZodEnum    → eq(col, v) only when v ∈ enum.options
 *   - ZodBoolean → eq(col, v === "true")
 *   - ZodNumber  → eq(col, Number(v)) only when the result is finite
 *   - anything else (Zod object, array, date, …) → skip (warn in dev)
 *
 * Returns `null` for "skip this column" — the caller appends to whereClauses
 * only when the dispatcher returns an SQL fragment. The skipped-key list is
 * surfaced in `appliedFilters._skipped` so the SM-9 audit row records the
 * user's intent even when the filter didn't reach the DB.
 */
function buildColumnFilter(
  zodType: z.ZodTypeAny | undefined,
  col: unknown,
  value: string,
): SQL | null {
  if (!zodType) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[admin-grid] filter skipped — no Zod schema for column`);
    }
    return null;
  }
  const inner = unwrapZod(zodType);
  const typeName = ((inner as unknown as { _def?: { typeName?: string } })._def
    ?.typeName) as string | undefined;

  if (typeName === "ZodString") {
    return ilike(col as never, `%${value}%`);
  }
  if (typeName === "ZodEnum") {
    const options = ((inner as unknown as { options?: readonly string[] })
      .options) ?? [];
    if (!options.includes(value)) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[admin-grid] filter skipped — enum value "${value}" not in ${JSON.stringify(options)}`,
        );
      }
      return null;
    }
    return eq(col as never, value as never);
  }
  if (typeName === "ZodBoolean") {
    return eq(col as never, (value === "true") as never);
  }
  if (typeName === "ZodNumber") {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[admin-grid] filter skipped — "${value}" is not numeric`);
      }
      return null;
    }
    return eq(col as never, n as never);
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[admin-grid] filter skipped — unsupported Zod type "${typeName}"`,
    );
  }
  return null;
}

export default async function AdminGridPage({ params, searchParams }: PageProps) {
  const { entity: slug } = await params;
  const sp = await searchParams;
  const entity = ADMIN_ENTITIES[slug];
  if (!entity) notFound();

  // Role gate — readRoles guards the page; mutateRoles enforced in actions.ts.
  const session = await requireRole(entity.readRoles);
  // Section gate, for entities whose rows a section password protects
  // (observation-cycles, mentor-pairings): without it the grid was a way to
  // read and export them round /observation's own gate. admin/access.ts.
  if (entity.gate) {
    await assertSectionGate(session.user.id, entity.gate, `/admin/data/${slug}`);
  }

  // Can THIS caller actually export?
  //
  // exportCsv re-gates PII-bearing entities to super_admin specifically, per
  // SM-9 -- but the button was rendered to anyone who could read the grid. So a
  // programme_admin on /admin/data/learners was shown "Export CSV", clicked it,
  // and was navigated away to /forbidden. Offering an action and then refusing
  // it reads as a broken permission rather than a deliberate one.
  const canExport =
    hasAnyRole(session.user.role, exportRolesFor(entity)) &&
    (!(entity.piiAudited && entity.slug === "learners") || session.user.role === "super_admin");

  // Same reasoning as canExport, in the other direction: readRoles gets you
  // onto this page, mutateRoles is what the import endpoint enforces. Rendering
  // "Import CSV" to an observer who can only read the grid would offer an
  // action that answers 403.
  // Mirrors the endpoint's own fallback exactly (mutateRoles ?? readRoles);
  // if these two ever disagree the button lies about what will happen.
  const canImport = hasAnyRole(session.user.role, entity.mutateRoles ?? entity.readRoles);

  const pageNum = Math.max(1, Number(sp.page ?? 1) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  // Spec 023: choose grid (desktop) vs cards (mobile) by reading the device
  // cookie set by useDeviceType(). The client effect keeps the cookie in
  // sync with the real viewport on each navigation, so SSR picks the right
  // layout from the first request after the cookie is established.
  const device = await getDeviceType();

  // Spec 114 + Spec 152: filter UI. `filter[<column>]=<value>` narrows the
  // underlying query. Spec 152 swaps the blanket-ilike for a column-type-aware
  // dispatcher (see `buildColumnFilter` above) — ilike for ZodString,
  // equality for ZodEnum / ZodBoolean / ZodNumber, skip-with-warn for
  // anything else. The skipped keys are still surfaced in `appliedFilters`
  // (under the `_skipped` map) so the SM-9 audit row captures user intent.
  const filters = extractFilters(sp);
  const columnsByKey = new Map(entity.displayColumns.map((c) => [c.key, c]));
  const tableColumns = entity.table as unknown as Record<string, unknown>;
  // UNWRAP BEFORE READING THE SHAPE.
  //
  // `_def.shape` exists on a ZodObject and on nothing else. Three entities --
  // resources, sessions and subjects -- declare their schema as
  // `z.object({...}).refine(...)`, which produces a ZodEffects WRAPPING the
  // object, so `_def.shape` was undefined, `formShape` fell back to `{}`, and
  // every column filter on those three entities hit the "unknown column type"
  // branch and was silently discarded. The filter box accepted input, the URL
  // changed, the audit row recorded the intent -- and the grid returned the
  // unfiltered table. Exactly the entities whose tables are largest.
  //
  // `.refine()` can nest, so this unwraps to a fixed point rather than one
  // level. ZodDefault / ZodOptional are handled for the same reason.
  const formShape = (() => {
    let schema: z.ZodTypeAny = entity.formSchema as unknown as z.ZodTypeAny;
    for (let depth = 0; depth < 10; depth++) {
      const def = schema._def as unknown as {
        shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>;
        schema?: z.ZodTypeAny;
        innerType?: z.ZodTypeAny;
      };
      if (def.shape) {
        const raw = typeof def.shape === "function" ? def.shape() : def.shape;
        return (raw ?? {}) as Record<string, z.ZodTypeAny>;
      }
      const inner = def.schema ?? def.innerType;
      if (!inner) break;
      schema = inner;
    }
    return {} as Record<string, z.ZodTypeAny>;
  })();
  const whereClauses: SQL[] = [];
  const appliedFilters: Record<string, string> = {};
  const skippedFilters: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!columnsByKey.has(key)) continue; // ignore unknown columns
    const col = tableColumns[key];
    if (!col) continue;
    const clause = buildColumnFilter(formShape[key], col, value);
    if (clause === null) {
      skippedFilters[key] = value;
      continue;
    }
    appliedFilters[key] = value;
    whereClauses.push(clause);
  }

  // Spec 114: edit mode — `?edit=<rowId>` opens the inline edit form.
  const editRowId = typeof sp.edit === "string" ? sp.edit : Array.isArray(sp.edit) ? sp.edit[0] : undefined;
  let editRow: Record<string, unknown> | undefined;
  if (editRowId) {
    const idCol = (entity.table as unknown as { id: unknown }).id;
    const editRows = (await db
      .select()
      .from(entity.table as never)
      .where(eq(idCol as never, editRowId))
      .limit(1)) as Record<string, unknown>[];
    editRow = editRows[0];
  }

  // Spec 157: sort param parsing. Whitelist the `sort` column to one of the
  // entity.displayColumns[].key values so a malicious user cannot inject SQL
  // via the search param. Default sort is `createdAt DESC` when the table
  // carries that column (every v2 table does), falling back to `id ASC`.
  const rawSort = typeof sp.sort === "string" ? sp.sort : Array.isArray(sp.sort) ? sp.sort[0] : undefined;
  const rawDir = typeof sp.dir === "string" ? sp.dir : Array.isArray(sp.dir) ? sp.dir[0] : undefined;
  const sortableKeys = new Set(entity.displayColumns.map((c) => c.key));
  const hasCreatedAt = "createdAt" in tableColumns;
  const sortKey =
    rawSort && sortableKeys.has(rawSort)
      ? rawSort
      : hasCreatedAt
        ? "createdAt"
        : "id";
  const sortDir: "asc" | "desc" =
    rawDir === "asc" || rawDir === "desc"
      ? rawDir
      : sortKey === "createdAt"
        ? "desc"
        : "asc";
  const sortCol = tableColumns[sortKey] ?? tableColumns["id"];

  // Drizzle's loose table typing here is acceptable for the generic grid path.
  // Specific admin views (spec 047+) can replace this with typed selects.
  const baseQuery = db.select().from(entity.table as never);
  const filteredQuery =
    whereClauses.length > 0
      ? baseQuery.where(whereClauses.length === 1 ? whereClauses[0]! : and(...whereClauses)!)
      : baseQuery;
  const sortedQuery = sortCol
    ? filteredQuery.orderBy((sortDir === "desc" ? desc : asc)(sortCol as never))
    : filteredQuery;
  const rows = (await sortedQuery.limit(PAGE_SIZE).offset(offset)) as Record<string, unknown>[];

  // SM-9 enforcement: PII-bearing entities (e.g. learners) must record every
  // server-side read in the audit log. recordAudit is fire-and-forget so a
  // failure here never breaks the page render.
  //
  // Spec 152 — `skippedFilters` captures user intent even when the column-type
  // dispatcher rejected the value (unknown enum option, NaN on a numeric
  // column, etc.) so the audit log still tells the full story of what the
  // user tried to narrow by.
  if (entity.piiAudited) {
    void recordAudit({
      action: `${entity.slug}.view`,
      entityType: entity.slug,
      metadata: {
        rowCount: rows.length,
        page: pageNum,
        filters: appliedFilters,
        skippedFilters,
      },
    });
  }

  // FOREIGN KEYS BY NAME. Every link to another row used to render as its
  // UUID, in the grid and on the mobile cards alike, so "which school is this
  // teacher at?" meant copying a UUID into another grid's filter. displayRows
  // carries the referenced row's label in place of the id for rendering only;
  // `rows` keeps the ids for edit links, selection and delete.
  // (admin/references.ts derives the FK fields from the table itself.)
  const refLabels = await referenceLabels(db, entity, rows);
  const displayRows = rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const [field, labels] of Object.entries(refLabels)) {
      const v = r[field];
      if (typeof v === "string" && labels[v]) out[field] = labels[v];
    }
    return out;
  });
  // The form's pickers: every row each FK field may point at, by name.
  const refOptions = await referenceOptions(db, entity);

  const fmt = (col: { key: string; format?: (v: unknown) => string }, row: Record<string, unknown>) => {
    const v = row[col.key];
    if (col.format) return col.format(v);
    if (v === null || v === undefined) return "—";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "boolean") return v ? "yes" : "no";
    return String(v);
  };

  // Preserve filter + sort querystring on pagination links (spec 157).
  const buildPageHref = (page: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(appliedFilters)) {
      params.set(`filter[${k}]`, v);
    }
    if (rawSort && sortableKeys.has(rawSort)) params.set("sort", sortKey);
    if (rawDir === "asc" || rawDir === "desc") params.set("dir", sortDir);
    params.set("page", String(page));
    return `?${params.toString()}`;
  };

  // Spec 157: build a sort link for a column header. Clicking cycles between
  // asc / desc (same column toggle) or sets a new column (default asc, or
  // desc for createdAt to keep recent rows on top).
  const buildSortHref = (colKey: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(appliedFilters)) {
      params.set(`filter[${k}]`, v);
    }
    const nextDir: "asc" | "desc" =
      sortKey === colKey
        ? sortDir === "asc"
          ? "desc"
          : "asc"
        : colKey === "createdAt"
          ? "desc"
          : "asc";
    params.set("sort", colKey);
    params.set("dir", nextDir);
    return `?${params.toString()}`;
  };

  // Row ids for the bulk-select client island. We compute server-side so the
  // "select all" checkbox knows which ids are currently rendered (page slice,
  // post-filter, post-sort).
  const allRowIds = rows
    .map((r) => (r.id != null ? String(r.id) : ""))
    .filter(Boolean);

  // Failures from deleteRowAction / bulkDeleteAction, which used to be
  // swallowed into console.error while the page revalidated and re-rendered
  // the undeleted row -- so the button looked broken rather than refused.
  const rawError = typeof sp.error === "string" ? sp.error : undefined;
  const GRID_ERRORS: Record<string, string> = {
    still_referenced:
      "That row can't be deleted because other records still reference it. Remove or reassign those first.",
    duplicate: "That change conflicts with an existing row.",
    delete_failed: "That delete could not be completed. Nothing was changed.",
  };
  // `ref` is the table that still references the row (actions.ts
  // gridErrorQuery). Named by its entity label, so the operator knows where to
  // go; an unregistered table falls back to the generic sentence.
  const rawRef = typeof sp.ref === "string" ? sp.ref : undefined;
  const refEntity = rawRef
    ? Object.values(ADMIN_ENTITIES).find((e) => getTableName(e.table) === rawRef)
    : undefined;
  // `locked` carries the entity guard's own sentence (actions.ts,
  // entity.guardMutation), e.g. why a signed-off cycle cannot be deleted.
  const rawDetail = typeof sp.detail === "string" ? sp.detail.slice(0, 300) : undefined;
  const gridError = rawError
    ? rawError === "locked"
      ? (rawDetail ?? "That row is locked in its current state.")
      : rawError === "still_referenced" && refEntity
      ? `That row can't be deleted because ${refEntity.label} records still reference it. Remove or reassign those first.`
      : (GRID_ERRORS[rawError] ?? "That action could not be completed.")
    : null;

  return (
    <main className="mx-auto max-w-6xl p-6">
      {gridError ? (
        <div
          role="alert"
          data-testid="grid-error"
          className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {gridError}
        </div>
      ) : null}
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            <Link href="/admin" className="hover:underline">Admin</Link> · Data
          </p>
          <h1 className="text-2xl font-semibold">{entity.label}</h1>
        </div>
        <div className="relative flex items-center gap-3 text-xs text-neutral-500">
          <span>Page {pageNum} · {rows.length} row{rows.length === 1 ? "" : "s"}</span>
          {canImport ? (
            <ImportCsv
              entitySlug={slug}
              entityLabel={entity.label}
              acceptedColumns={[...entity.formFields]}
            />
          ) : null}
          {canExport ? (
            <a
              href={`/api/admin/data/${slug}/export`}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 hover:border-neutral-400"
              title="Download CSV"
            >Export CSV</a>
          ) : (
            <span
              className="rounded-md border border-neutral-200 px-2 py-1 text-neutral-400"
              title="Exporting learner records requires a super administrator"
            >Export CSV</span>
          )}
        </div>
      </header>

      {/* Spec 114: edit panel. When ?edit=<id> is set and the row was found,
          swap the "Add new" form for an "Edit row" form prefilled with values. */}
      {editRowId && editRow ? (
        <section className="mb-8 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-amber-900">Edit row</h2>
            <Link href={`/admin/data/${slug}`} className="text-xs text-amber-900 hover:underline">
              Close
            </Link>
          </div>
          <RowForm
            entitySlug={slug}
            mode="edit"
            rowId={editRowId}
            initialValues={editRow}
            options={refOptions}
          />
        </section>
      ) : (
        <section className="mb-8 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-700">Add new</h2>
          <RowForm entitySlug={slug} mode="create" options={refOptions} />
        </section>
      )}

      {/* Spec 114: column-filter toolbar. URL-driven (`?filter[<col>]=<value>`).
          Mirrors admin.jsx::AdminTable toolbar (lines 111-114). */}
      <section className="mb-4 rounded-lg border border-neutral-200 bg-white p-3">
        <form method="get" className="flex flex-wrap items-end gap-2" data-filter-form="true">
          {entity.displayColumns.map((c) => (
            <label key={c.key} className="flex min-w-[8rem] flex-col gap-1 text-[11px] text-neutral-600">
              <span className="font-medium">{c.label}</span>
              <input
                name={`filter[${c.key}]`}
                defaultValue={appliedFilters[c.key] ?? ""}
                placeholder="contains…"
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-900 focus:outline-none"
              />
            </label>
          ))}
          <div className="flex gap-2 pb-1">
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white"
            >
              Apply filters
            </button>
            {Object.keys(appliedFilters).length > 0 ? (
              <a
                href={`/admin/data/${slug}`}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-400"
              >
                Clear
              </a>
            ) : null}
          </div>
        </form>
      </section>

      {device === "mobile" ? (
        <>
          <section className="mb-4">
            <MobileEntityCardList
              entitySlug={slug}
              entityLabel={entity.label}
              rows={displayRows}
              columns={entity.displayColumns.map((c) => ({
                key: c.key,
                label: c.label,
                format: c.format,
              }))}
            />
          </section>
          <nav
            className="mb-6 flex items-center justify-between rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-500"
            aria-label="Card list pagination"
          >
            <div>
              {pageNum > 1 ? (
                <Link href={buildPageHref(pageNum - 1)} className="hover:underline">← Prev</Link>
              ) : (
                <span className="text-neutral-300">← Prev</span>
              )}
            </div>
            <div>Page {pageNum}</div>
            <div>
              {rows.length === PAGE_SIZE ? (
                <Link href={buildPageHref(pageNum + 1)} className="hover:underline">Next →</Link>
              ) : (
                <span className="text-neutral-300">Next →</span>
              )}
            </div>
          </nav>
        </>
      ) : null}

      <section
        className="rounded-lg border border-neutral-200 bg-white"
        style={device === "mobile" ? { display: "none" } : undefined}
        aria-hidden={device === "mobile"}
      >
        <BulkSelectionProvider allRowIds={allRowIds}>
          {/* Spec 157: sticky bulk-action toolbar — only visible when ≥1 row is selected. */}
          <BulkDeleteToolbar entitySlug={slug} />
          <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                {/* Spec 157: select-all checkbox column. */}
                <th
                  scope="col"
                  className="w-8 px-3 py-2 font-medium"
                  data-bulk-select-col="true"
                >
                  <BulkSelectAllCheckbox />
                </th>
                {entity.displayColumns.map((c) => {
                  const isActive = sortKey === c.key;
                  const arrow = isActive ? (sortDir === "asc" ? " ↑" : " ↓") : "";
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className="px-3 py-2 font-medium"
                      aria-sort={
                        isActive
                          ? sortDir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <Link
                        href={buildSortHref(c.key)}
                        role="button"
                        data-sort-header={c.key}
                        className="inline-flex items-center gap-1 hover:text-neutral-900"
                      >
                        {c.label}
                        <span aria-hidden="true">{arrow}</span>
                      </Link>
                    </th>
                  );
                })}
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={entity.displayColumns.length + 2} className="px-3 py-8 text-center text-neutral-500">
                    {Object.keys(appliedFilters).length > 0
                      ? "No rows match the active filters. Clear filters to see everything."
                      : "No rows yet. Add one above."}
                  </td>
                </tr>
              ) : (
                displayRows.map((row, i) => {
                  const rowId = row.id != null ? String(row.id) : "";
                  const rowLabel = entity.describeRow?.(row);
                  return (
                    <tr key={rowId || i} className="border-t border-neutral-100">
                      {/* Spec 157: per-row bulk-select checkbox. */}
                      <td className="px-3 py-2">
                        {rowId ? <BulkRowCheckbox rowId={rowId} /> : null}
                      </td>
                      {entity.displayColumns.map((c) => (
                        <td key={c.key} className="px-3 py-2">{fmt(c, row)}</td>
                      ))}
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {rowId ? (
                            <Link
                              href={`/admin/data/${slug}?edit=${encodeURIComponent(rowId)}`}
                              className="text-xs text-neutral-700 hover:underline"
                              data-action="edit-row"
                            >
                              Edit
                            </Link>
                          ) : null}
                          {rowId ? (
                            <DeleteRowButton
                              entitySlug={slug}
                              rowId={rowId}
                              rowLabel={rowLabel}
                            />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <nav className="flex items-center justify-between border-t border-neutral-100 px-3 py-2 text-xs text-neutral-500">
          <div>
            {pageNum > 1 ? (
              <Link href={buildPageHref(pageNum - 1)} className="hover:underline">← Prev</Link>
            ) : (
              <span className="text-neutral-300">← Prev</span>
            )}
          </div>
          <div>
            {rows.length === PAGE_SIZE ? (
              <Link href={buildPageHref(pageNum + 1)} className="hover:underline">Next →</Link>
            ) : (
              <span className="text-neutral-300">Next →</span>
            )}
          </div>
        </nav>
        </BulkSelectionProvider>
      </section>
    </main>
  );
}
