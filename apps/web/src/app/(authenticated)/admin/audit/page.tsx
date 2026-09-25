import Link from "next/link";
import { desc, gte, lt, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { auditLog, users } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { AUDIT_EXPORT_ROW_CAP } from "@/admin/audit-export";
import { istDayRange } from "@/admin/dates";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AuditViewer({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; user?: string; page?: string; from?: string; to?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);
  const sp = await searchParams;
  const page = Math.max(0, Number(sp.page ?? 0));

  // A PERSON, BY THE ADDRESS THIS PAGE SHOWS. The filter took only a uuid and,
  // on rejection, said to copy the id "from the User column below" -- a column
  // that shows the email -- while no admin screen displays a user id at all.
  // So "what did this person do?", the basic forensic question, could not be
  // asked. An email address is resolved to the account here; a uuid still works.
  const typedUser = sp.user?.trim() ?? "";
  let resolvedUser: string | null = null;
  if (typedUser.includes("@")) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${typedUser.toLowerCase()}`)
      .limit(1);
    resolvedUser = u?.id ?? null;
  }

  // FROM / TO, calendar days in IST (admin/dates.ts). The export refuses more
  // than AUDIT_EXPORT_ROW_CAP rows and says to narrow with ?from= / ?to=, but
  // this page -- the only way to reach the export -- had no date inputs.
  const fromDay = sp.from ? istDayRange(sp.from) : null;
  const toDay = sp.to ? istDayRange(sp.to) : null;

  // Lightweight join — pull last N events, optionally filtered by action / user_id.
  //
  // `?user=` is bound against a uuid column. Anything that is not a uuid makes
  // Postgres raise 22P02 (invalid input syntax for type uuid), which surfaces
  // as a 500 on the audit page — so a typo, or a pasted email address, or a
  // truncated id took down the surface an administrator goes to when something
  // has gone wrong. Validated here and ignored if malformed: an unparseable
  // filter is a filter that matches nothing, not an error page.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const userFilter = UUID_RE.test(typedUser) ? typedUser : resolvedUser;
  const userFilterRejected = Boolean(typedUser) && userFilter === null;

  const filters: ReturnType<typeof sql>[] = [];
  if (sp.action) filters.push(sql`${auditLog.action} = ${sp.action}`);
  if (userFilter) filters.push(sql`${auditLog.userId} = ${userFilter}`);
  if (fromDay) filters.push(gte(auditLog.createdAt, fromDay[0]));
  if (toDay) filters.push(lt(auditLog.createdAt, toDay[1]));
  const whereClause =
    filters.length === 0
      ? sql`true`
      : sql.join(filters, sql.raw(" AND "));

  // THE ACTION DROPDOWN IS BUILT FROM THE DATA, NOT FROM A LITERAL LIST.
  //
  // It used to offer nine bare names -- view, download, upload, edit, delete,
  // gate_pass, gate_fail, login, logout -- and the filter is an exact equality
  // match. Nothing in the repository writes any of them: every action this
  // application records is dotted and namespaced (observation.signed_off,
  // admin.row.delete, video.play, teach_back.reviewed, form.submit ...). So
  // every option in the dropdown returned zero rows, on the surface an
  // administrator opens precisely when something has gone wrong.
  //
  // A DISTINCT over the column cannot drift: the options are exactly the
  // actions that exist.
  //
  // BOUNDED BY TIME. Unbounded, this DISTINCT read the whole of audit_log on
  // every page load -- the one table that is append-only and never pruned --
  // so the dropdown alone got slower every day. The last 90 days is a range
  // scan of audit_log_created_idx and still cannot drift. The action currently
  // being filtered on is kept as an option even if it is older than that, so
  // re-submitting the form never silently drops the filter.
  // The cutoff is the database's clock, as on admin/gates and
  // admin/transcode-jobs.
  const actionOptions = (
    await db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .where(gte(auditLog.createdAt, sql`now() - interval '90 days'`))
      .orderBy(auditLog.action)
  ).map((r) => r.action);
  if (sp.action && !actionOptions.includes(sp.action)) {
    actionOptions.push(sp.action);
    actionOptions.sort();
  }

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

  // Build the export query string — mirrors the filter form's params (action,
  // user) plus drops `page` so the CSV always covers the full filtered slice.
  // Wired by spec 116 to /api/admin/audit/export which streams text/csv with
  // a Content-Disposition attachment header.
  const exportQs = new URLSearchParams();
  if (sp.action) exportQs.set("action", sp.action);
  // `userFilter`, not `sp.user`. This page validates the id and IGNORES it when
  // malformed -- then built the export link from the raw value anyway, so the
  // CSV route received the same unparseable string this page had just rejected
  // and bound it straight into a uuid comparison, producing a 500. The
  // documented "typo or truncated id must not take down the surface an
  // administrator goes to when something has gone wrong" held for the page and
  // not for the download button beside it.
  if (userFilter) exportQs.set("user", userFilter);
  // The same IST day boundaries the table above uses, as instants.
  if (fromDay) exportQs.set("from", fromDay[0].toISOString());
  if (toDay) exportQs.set("to", toDay[1].toISOString());
  const exportHref = exportQs.toString()
    ? `/api/admin/audit/export?${exportQs.toString()}`
    : `/api/admin/audit/export`;

  // Would the export refuse? It answers 413 JSON above the cap, which an
  // <a download> saves as a file of JSON with no word on this page. Counted
  // with a LIMIT, so the check costs at most cap+1 index rows.
  const matching = Number(
    (
      await db.execute(
        sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${auditLog} WHERE ${whereClause} LIMIT ${AUDIT_EXPORT_ROW_CAP + 1}) s`,
      )
    ).rows[0]?.n ?? 0,
  );
  const exportTooLarge = matching > AUDIT_EXPORT_ROW_CAP;

  // Keep every filter when paging or following a User link.
  const withParams = (over: Record<string, string>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) q.set(k, String(v));
    return `?${q.toString()}`;
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-neutral-500">
          Append-only record of every protected view, edit, upload, and gate event.
        </p>
      </header>

      {userFilterRejected ? (
        <p
          role="status"
          data-testid="audit-user-filter-rejected"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          The user filter was ignored — no account matches <code>{sp.user}</code>. Enter the
          address shown in the User column, or click a name there.
        </p>
      ) : null}

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Action</span>
          <select name="action" defaultValue={sp.action ?? ""} className="rounded-md border border-neutral-300 px-2 py-1">
            <option value="">any</option>
            {actionOptions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">User (email or id)</span>
          <input name="user" defaultValue={sp.user ?? ""} className="rounded-md border border-neutral-300 px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">From</span>
          <input type="date" name="from" defaultValue={fromDay ? sp.from : ""} className="rounded-md border border-neutral-300 px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">To</span>
          <input type="date" name="to" defaultValue={toDay ? sp.to : ""} className="rounded-md border border-neutral-300 px-2 py-1" />
        </label>
        <button type="submit" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white">Filter</button>
        {exportTooLarge ? (
          <span
            role="status"
            data-testid="audit-export-too-large"
            className="ml-auto text-xs text-amber-800"
          >
            More than {AUDIT_EXPORT_ROW_CAP.toLocaleString("en-IN")} events match — narrow From/To to export.
          </span>
        ) : (
          <Link
            href={exportHref}
            download
            className="ml-auto rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 hover:bg-neutral-50"
          >
            Export CSV
          </Link>
        )}
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
                  <td className="px-3 py-2 text-xs">
                    {r.userId ? (
                      // A person's events are one click away; this is also the
                      // only place their id is reachable from the UI.
                      <a href={withParams({ user: r.userId, page: "" })} className="hover:underline" title={r.userId}>
                        {r.userEmail ?? r.userId}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
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
            <a href={withParams({ page: String(page - 1) })} className="rounded-md border border-neutral-300 px-3 py-1">← Prev</a>
          ) : null}
          {rows.length === PAGE_SIZE ? (
            <a href={withParams({ page: String(page + 1) })} className="rounded-md border border-neutral-300 px-3 py-1">Next →</a>
          ) : null}
        </div>
      </nav>
    </main>
  );
}
