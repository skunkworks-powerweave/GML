import { desc, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { auditLog, users } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AuditViewer({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; user?: string; page?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);
  const sp = await searchParams;
  const page = Math.max(0, Number(sp.page ?? 0));

  // Lightweight join — pull last N events, optionally filtered by action / user_id.
  const filters: ReturnType<typeof sql>[] = [];
  if (sp.action) filters.push(sql`${auditLog.action} = ${sp.action}`);
  if (sp.user) filters.push(sql`${auditLog.userId} = ${sp.user}`);
  const whereClause =
    filters.length === 0
      ? sql`true`
      : sql.join(filters, sql.raw(" AND "));

  const rows = await db
    .select({
      id: auditLog.id,
      userId: auditLog.userId,
      userEmail: users.email,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      ip: auditLog.ip,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, sql`${users.id} = ${auditLog.userId}`)
    .where(whereClause)
    .orderBy(desc(auditLog.createdAt))
    .limit(PAGE_SIZE)
    .offset(page * PAGE_SIZE);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-neutral-500">
          Append-only record of every protected view, edit, upload, and gate event.
        </p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Action</span>
          <select name="action" defaultValue={sp.action ?? ""} className="rounded-md border border-neutral-300 px-2 py-1">
            <option value="">any</option>
            {["view", "download", "upload", "edit", "delete", "gate_pass", "gate_fail", "login", "logout"].map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">User id</span>
          <input name="user" defaultValue={sp.user ?? ""} className="rounded-md border border-neutral-300 px-2 py-1" />
        </label>
        <button type="submit" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white">Filter</button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Entity</th>
              <th className="px-3 py-2">IP</th>
              <th className="px-3 py-2">Metadata</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                  No events.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-neutral-100">
                  <td className="px-3 py-2 text-xs">{r.createdAt?.toISOString().slice(0, 19).replace("T", " ")}</td>
                  <td className="px-3 py-2 text-xs">{r.userEmail ?? r.userId ?? "—"}</td>
                  <td className="px-3 py-2 text-xs"><code>{r.action}</code></td>
                  <td className="px-3 py-2 text-xs">{r.entityType ? `${r.entityType}/${r.entityId ?? ""}` : "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.ip ?? "—"}</td>
                  <td className="px-3 py-2 text-xs max-w-md truncate">{r.metadata ? JSON.stringify(r.metadata) : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <nav className="flex items-center justify-between text-sm">
        <span className="text-xs text-neutral-500">Page {page + 1}</span>
        <div className="flex gap-2">
          {page > 0 ? (
            <a href={`?${new URLSearchParams({ ...sp, page: String(page - 1) }).toString()}`} className="rounded-md border border-neutral-300 px-3 py-1">← Prev</a>
          ) : null}
          {rows.length === PAGE_SIZE ? (
            <a href={`?${new URLSearchParams({ ...sp, page: String(page + 1) }).toString()}`} className="rounded-md border border-neutral-300 px-3 py-1">Next →</a>
          ) : null}
        </div>
      </nav>
    </main>
  );
}
