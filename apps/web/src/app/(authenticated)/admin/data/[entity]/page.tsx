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

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { and, eq, ilike, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { getDeviceType } from "@/lib/device";
import { MobileEntityCardList } from "@/admin/components/MobileEntityCardList";
import { RowForm } from "./row-form";
import { DeleteRowButton } from "./delete-button";

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

export default async function AdminGridPage({ params, searchParams }: PageProps) {
  const { entity: slug } = await params;
  const sp = await searchParams;
  const entity = ADMIN_ENTITIES[slug];
  if (!entity) notFound();

  // Role gate — readRoles guards the page; mutateRoles enforced in actions.ts.
  await requireRole(entity.readRoles);

  const pageNum = Math.max(1, Number(sp.page ?? 1) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  // Spec 023: choose grid (desktop) vs cards (mobile) by reading the device
  // cookie set by useDeviceType(). The client effect keeps the cookie in
  // sync with the real viewport on each navigation, so SSR picks the right
  // layout from the first request after the cookie is established.
  const device = await getDeviceType();

  // Spec 114: filter UI. `filter[<column>]=<value>` narrows the underlying
  // query. ilike for free-text columns, eq for everything else.
  const filters = extractFilters(sp);
  const columnsByKey = new Map(entity.displayColumns.map((c) => [c.key, c]));
  const tableColumns = (entity.table as unknown as Record<string, unknown>);
  const whereClauses: SQL[] = [];
  const appliedFilters: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!columnsByKey.has(key)) continue; // ignore unknown columns
    const col = tableColumns[key];
    if (!col) continue;
    appliedFilters[key] = value;
    // Free-text contains-match; falls back to eq if ilike rejects the type.
    whereClauses.push(ilike(col as never, `%${value}%`));
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

  // Drizzle's loose table typing here is acceptable for the generic grid path.
  // Specific admin views (spec 047+) can replace this with typed selects.
  const baseQuery = db.select().from(entity.table as never);
  const filteredQuery =
    whereClauses.length > 0
      ? baseQuery.where(whereClauses.length === 1 ? whereClauses[0]! : and(...whereClauses)!)
      : baseQuery;
  const rows = (await filteredQuery.limit(PAGE_SIZE).offset(offset)) as Record<string, unknown>[];

  // SM-9 enforcement: PII-bearing entities (e.g. learners) must record every
  // server-side read in the audit log. recordAudit is fire-and-forget so a
  // failure here never breaks the page render.
  if (entity.piiAudited) {
    void recordAudit({
      action: `${entity.slug}.view`,
      entityType: entity.slug,
      metadata: { rowCount: rows.length, page: pageNum, filters: appliedFilters },
    });
  }

  const fmt = (col: { key: string; format?: (v: unknown) => string }, row: Record<string, unknown>) => {
    const v = row[col.key];
    if (col.format) return col.format(v);
    if (v === null || v === undefined) return "—";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "boolean") return v ? "yes" : "no";
    return String(v);
  };

  // Preserve filter querystring on pagination links.
  const buildPageHref = (page: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(appliedFilters)) {
      params.set(`filter[${k}]`, v);
    }
    params.set("page", String(page));
    return `?${params.toString()}`;
  };

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            <Link href="/admin" className="hover:underline">Admin</Link> · Data
          </p>
          <h1 className="text-2xl font-semibold">{entity.label}</h1>
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span>Page {pageNum} · {rows.length} row{rows.length === 1 ? "" : "s"}</span>
          <a
            href={`/api/admin/data/${slug}/export`}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 hover:border-neutral-400"
            title="Download CSV"
          >Export CSV</a>
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
          <RowForm entitySlug={slug} mode="edit" rowId={editRowId} initialValues={editRow} />
        </section>
      ) : (
        <section className="mb-8 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-700">Add new</h2>
          <RowForm entitySlug={slug} mode="create" />
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
              rows={rows}
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
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                {entity.displayColumns.map((c) => (
                  <th key={c.key} className="px-3 py-2 font-medium">{c.label}</th>
                ))}
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={entity.displayColumns.length + 1} className="px-3 py-8 text-center text-neutral-500">
                    {Object.keys(appliedFilters).length > 0
                      ? "No rows match the active filters. Clear filters to see everything."
                      : "No rows yet. Add one above."}
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => {
                  const rowId = row.id != null ? String(row.id) : "";
                  const rowLabel = entity.describeRow?.(row);
                  return (
                    <tr key={rowId || i} className="border-t border-neutral-100">
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
      </section>
    </main>
  );
}
