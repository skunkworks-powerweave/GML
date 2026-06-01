// Generic no-code admin grid. Renders any entity registered in ADMIN_ENTITIES.
// Server component — reads via Drizzle, gates by role, renders the table.
// Mutations live in actions.ts; the row form is row-form.tsx.
//
// SM-1 reminder: every mutation goes through withAudit() in actions.ts.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@gml/db";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { RowForm } from "./row-form";
import { deleteRowAction } from "./actions";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ entity: string }>;
  searchParams: Promise<{ page?: string }>;
};

const PAGE_SIZE = 50;

export default async function AdminGridPage({ params, searchParams }: PageProps) {
  const { entity: slug } = await params;
  const sp = await searchParams;
  const entity = ADMIN_ENTITIES[slug];
  if (!entity) notFound();

  // Role gate — readRoles guards the page; mutateRoles enforced in actions.ts.
  await requireRole(entity.readRoles);

  const pageNum = Math.max(1, Number(sp.page ?? 1) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  // Drizzle's loose table typing here is acceptable for the generic grid path.
  // Specific admin views (spec 047+) can replace this with typed selects.
  const rows = (await db
    .select()
    .from(entity.table as never)
    .limit(PAGE_SIZE)
    .offset(offset)) as Record<string, unknown>[];

  // SM-9 enforcement: PII-bearing entities (e.g. learners) must record every
  // server-side read in the audit log. recordAudit is fire-and-forget so a
  // failure here never breaks the page render.
  if (entity.piiAudited) {
    void recordAudit({
      action: `${entity.slug}.view`,
      entityType: entity.slug,
      metadata: { rowCount: rows.length, page: pageNum },
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

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            <Link href="/admin" className="hover:underline">Admin</Link> · Data
          </p>
          <h1 className="text-2xl font-semibold">{entity.label}</h1>
        </div>
        <div className="text-xs text-neutral-500">
          Page {pageNum} · {rows.length} row{rows.length === 1 ? "" : "s"}
        </div>
      </header>

      <section className="mb-8 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-700">Add new</h2>
        <RowForm entitySlug={slug} mode="create" />
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white">
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
                    No rows yet. Add one above.
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => (
                  <tr key={String(row.id ?? i)} className="border-t border-neutral-100">
                    {entity.displayColumns.map((c) => (
                      <td key={c.key} className="px-3 py-2">{fmt(c, row)}</td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      <form action={deleteRowAction} className="inline">
                        <input type="hidden" name="entitySlug" value={slug} />
                        <input type="hidden" name="rowId" value={String(row.id ?? "")} />
                        <button
                          type="submit"
                          className="text-xs text-red-700 hover:underline"
                        >
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <nav className="flex items-center justify-between border-t border-neutral-100 px-3 py-2 text-xs text-neutral-500">
          <div>
            {pageNum > 1 ? (
              <Link href={`?page=${pageNum - 1}`} className="hover:underline">← Prev</Link>
            ) : (
              <span className="text-neutral-300">← Prev</span>
            )}
          </div>
          <div>
            {rows.length === PAGE_SIZE ? (
              <Link href={`?page=${pageNum + 1}`} className="hover:underline">Next →</Link>
            ) : (
              <span className="text-neutral-300">Next →</span>
            )}
          </div>
        </nav>
      </section>
    </main>
  );
}
