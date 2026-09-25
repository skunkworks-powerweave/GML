// /repo/sessions — every classroom session held (planned / in progress / complete).
// Port of repository.jsx::RepoSessionsIndex (lines 693-746) — 1:1 visual fidelity.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): the status + subject
// filters used to run in-memory over `rows.filter(...)` after a 200-row
// query. They now apply directly in the SQL WHERE clause via URL search
// params. Adds an optional `from` / `to` date range so operators can scope
// to a specific window (the prototype's "More filters" affordance).
//
// Spec 153 (Workflow Run 14 audit-closure MEDIUM): the from / to validators
// used to short-circuit on the shape regex `^\d{4}-\d{2}-\d{2}$` ONLY. A
// caller-crafted URL like ?from=2026-13-45 satisfies the regex but is not
// a real calendar date — Postgres then throws "date/time field value out of
// range" on the cast, surfacing as a 500 instead of a graceful filter-skip.
// The fix layers a `new Date(value)` parse + `!isNaN()` check after the
// regex so malformed dates are silently dropped (filter behaves as if the
// param were absent) and the user gets the unfiltered list with no error
// banner. We do NOT 400; the goal is to harden against the bad URL, not
// surface it to the user — the URL is normally produced by the form's
// `<input type="date">` which only ever yields valid ISO dates.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, gte, ilike, lte, sql, type SQL } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@gml/db";
import { sessions, schools, classes, subjects, teachers } from "@gml/db/schema";
// Spec 138 — mobile card-list fallback (desktop keeps the 9-col table).
import { getDeviceType } from "@/lib/device";
import { MobileRepoCardList } from "@/components/repo/MobileRepoCardList";
import { escapeIlike } from "@gml/shared/sql/ilike";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sessions" };

const ALLOWED_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

const STATUS_CHIP: Record<string, { kind: string; label: string }> = {
  planned: { kind: "", label: "Planned" },
  in_progress: { kind: "chip-saffron", label: "In progress" },
  complete: { kind: "chip-lichen", label: "Complete" },
  cancelled: { kind: "", label: "Cancelled" },
};

const STATUS_VALUES = new Set(["planned", "in_progress", "complete", "cancelled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Spec 158 — repo-search-bar contract: ?q= filters on sessions.topic
// (sessions don't have a "name"; topic is the primary user-visible
// label). 200-char cap + escape ILIKE wildcards.
const SEARCH_Q_MAX = 200;

// Spec 153 — accept only well-formed ISO yyyy-mm-dd strings AND validate the
// calendar values (month 1-12, day in range for the month). Postgres would
// otherwise throw on the date-column cast with a malformed value, surfacing
// as a 500. Returns the input on success, undefined on failure so the caller
// can drop the filter.
function parseIsoDateFilter(value: string | undefined): string | undefined {
  if (!value || !ISO_DATE_RE.test(value)) return undefined;
  const parsed = new Date(value + "T00:00:00Z");
  if (isNaN(parsed.getTime())) return undefined;
  // Round-trip check: Date constructor silently normalises (Feb 30 → Mar 2)
  // so we also require the input string to match the parsed Y-M-D. This
  // catches "2026-13-45", "2026-02-30", etc. that pass the regex AND the
  // !isNaN check but represent a different calendar day than the input.
  const iso = parsed.toISOString().slice(0, 10);
  return iso === value ? value : undefined;
}

type SearchParams = Promise<{
  status?: string;
  subject?: string;
  from?: string;
  to?: string;
  q?: string;
}>;

export default async function RepoSessionsIndex({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  const role = session?.user?.role;
  if (!role || !ALLOWED_ROLES.has(role)) redirect("/forbidden");

  const sp = await searchParams;
  const statusFilter = STATUS_VALUES.has(sp.status ?? "") ? sp.status! : "all";
  const subjectFilter =
    sp.subject && UUID_RE.test(sp.subject) ? sp.subject : "all";
  // Spec 153 — regex + calendar validation. parseIsoDateFilter returns the
  // input on success, undefined on failure (malformed format, impossible
  // calendar day, or after the Date round-trip normalisation diverges).
  const fromFilter = parseIsoDateFilter(sp.from);
  const toFilter = parseIsoDateFilter(sp.to);
  // Spec 158 — topic search on sessions.topic.
  const qRaw = (sp.q ?? "").slice(0, SEARCH_Q_MAX);
  const qFilter = qRaw.trim().length > 0 ? qRaw.trim() : null;

  // Build the WHERE clause server-side. We compare scheduled_date (date
  // column) against ISO yyyy-mm-dd strings — Postgres handles the cast.
  const conds: SQL[] = [];
  if (statusFilter !== "all") conds.push(eq(sessions.status, statusFilter));
  if (subjectFilter !== "all") conds.push(eq(sessions.subjectId, subjectFilter));
  if (fromFilter) conds.push(gte(sessions.scheduledDate, fromFilter));
  if (toFilter) conds.push(lte(sessions.scheduledDate, toFilter));
  // Spec 158 — combine the topic filter via and(...).
  if (qFilter) conds.push(ilike(sessions.topic, `%${escapeIlike(qFilter)}%`));

  const visible = await db
    .select({
      id: sessions.id,
      scheduledDate: sessions.scheduledDate,
      scheduledTime: sessions.scheduledTime,
      topic: sessions.topic,
      status: sessions.status,
      attendedCount: sessions.attendedCount,
      totalCount: sessions.totalCount,
      observed: sessions.observed,
      schoolCode: schools.code,
      grade: classes.grade,
      subjectId: sessions.subjectId,
      subjectName: subjects.name,
      subjectColor: subjects.color,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(sessions)
    .leftJoin(schools, eq(sessions.schoolId, schools.id))
    .leftJoin(classes, eq(sessions.classId, classes.id))
    .leftJoin(subjects, eq(sessions.subjectId, subjects.id))
    .leftJoin(teachers, eq(sessions.teacherId, teachers.id))
    .where(conds.length === 0 ? undefined : and(...conds))
    .orderBy(desc(sessions.scheduledDate), desc(sessions.scheduledTime))
    .limit(200);

  const subjectOptions = await db
    .select({ id: subjects.id, name: subjects.name })
    .from(subjects)
    .where(eq(subjects.active, true))
    .orderBy(subjects.displayOrder);

  // Per-status counts in a single GROUP BY round-trip so the filter tabs
  // stay accurate even when the table has narrowed.
  const statusCountRows = await db
    .select({
      status: sessions.status,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(sessions)
    .groupBy(sessions.status);
  const totalSessions = statusCountRows.reduce((acc, r) => acc + r.n, 0);
  const countByStatus = (v: string) =>
    statusCountRows.find((r) => r.status === v)?.n ?? 0;
  const counts = {
    all: totalSessions,
    planned: countByStatus("planned"),
    in_progress: countByStatus("in_progress"),
    complete: countByStatus("complete"),
  };

  const filterTabs = [
    { v: "all", l: "All", n: counts.all },
    { v: "planned", l: "Planned", n: counts.planned },
    { v: "in_progress", l: "Today", n: counts.in_progress },
    { v: "complete", l: "Complete", n: counts.complete },
  ];

  // Spec 138 — device-aware card/table fork.
  const device = await getDeviceType();

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Sessions</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 720 }}>
          Every classroom session held — planned, in progress and complete. Each session links to its
          school, class, subject, teacher and course outline.
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {/* Filter card */}
        <div
          className="card card-hi"
          style={{ padding: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {filterTabs.map((f) => {
              const active = statusFilter === f.v;
              const qs = new URLSearchParams();
              if (f.v !== "all") qs.set("status", f.v);
              if (subjectFilter !== "all") qs.set("subject", subjectFilter);
              if (fromFilter) qs.set("from", fromFilter);
              if (toFilter) qs.set("to", toFilter);
              // Spec 158 — preserve the active topic search across status-tab clicks.
              if (qFilter) qs.set("q", qFilter);
              const q = qs.toString();
              const href = q ? `/repo/sessions?${q}` : "/repo/sessions";
              return (
                <Link
                  key={f.v}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className="btn btn-sm"
                  style={{
                    background: active ? "var(--ink)" : "transparent",
                    color: active ? "var(--paper)" : "var(--ink-2)",
                    borderColor: active ? "var(--ink)" : "transparent",
                    boxShadow: "none",
                    textDecoration: "none",
                  }}
                >
                  {f.l}{" "}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.n}</span>
                </Link>
              );
            })}
          </div>

          <div style={{ width: 1, height: 20, background: "var(--line)" }} />

          <form method="GET" action="/repo/sessions" style={{ display: "contents" }}>
            {statusFilter !== "all" ? <input type="hidden" name="status" value={statusFilter} /> : null}
            {/* Spec 158 — topic search input. Submits alongside the
                existing subject/from/to fields so the URL is one shareable
                state. */}
            <input
              type="search"
              name="q"
              defaultValue={qFilter ?? ""}
              aria-label="Search sessions by topic"
              title="Search sessions by topic"
              maxLength={SEARCH_Q_MAX}
              className="text"
              style={{ padding: "5px 10px", fontSize: 12, minWidth: 160 }}
            />
            <select
              name="subject"
              aria-label="Filter by subject"
              defaultValue={subjectFilter}
              className="text"
              style={{ maxWidth: 200, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="all">All subjects</option>
              {subjectOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              name="from"
              defaultValue={fromFilter ?? ""}
              aria-label="from"
              className="text"
              style={{ padding: "5px 10px", fontSize: 12 }}
            />
            <input
              type="date"
              name="to"
              defaultValue={toFilter ?? ""}
              aria-label="to"
              className="text"
              style={{ padding: "5px 10px", fontSize: 12 }}
            />
            <button type="submit" className="btn btn-sm">
              Apply
            </button>
            {qFilter ? (
              <Link
                href={(() => {
                  const qs = new URLSearchParams();
                  if (statusFilter !== "all") qs.set("status", statusFilter);
                  if (subjectFilter !== "all") qs.set("subject", subjectFilter);
                  if (fromFilter) qs.set("from", fromFilter);
                  if (toFilter) qs.set("to", toFilter);
                  const q = qs.toString();
                  return q ? `/repo/sessions?${q}` : "/repo/sessions";
                })()}
                className="btn btn-sm"
                style={{ textDecoration: "none" }}
              >
                Clear
              </Link>
            ) : null}
          </form>

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{visible.length} shown</span>
          </div>
        </div>

        {/* Spec 138 — mobile branch: card list. Desktop keeps the table. */}
        {device === "mobile" ? (
          <MobileRepoCardList
            testIdSuffix="sessions"
            emptyMessage="No sessions recorded yet."
            items={visible.map((s) => {
              const statusInfo = STATUS_CHIP[s.status] ?? STATUS_CHIP.planned;
              return {
                id: s.id,
                primary: s.topic ?? "(untitled session)",
                hindi: s.teacherHindi ?? null,
                href: `/repo/session/${s.id}`,
                chip: { label: statusInfo.label, kind: statusInfo.kind },
                secondary: [
                  {
                    value: `${s.scheduledDate}${s.scheduledTime ? ` · ${s.scheduledTime}` : ""}`,
                    mono: true,
                  },
                  {
                    value: `${s.subjectName ?? "—"} · Grade ${s.grade ?? "—"} · ${s.schoolCode ?? "—"}`,
                  },
                  { label: "Teacher", value: s.teacherName ?? "—" },
                ],
              };
            })}
          />
        ) : null}

        {/* Table card */}
        <div className="card card-hi" style={device === "mobile" ? { display: "none" } : undefined} aria-hidden={device === "mobile"}>
          <table className="t">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>School</th>
                <th>Grade</th>
                <th>Subject</th>
                <th>Topic</th>
                <th>Teacher</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    style={{ textAlign: "center", color: "var(--ink-3)", padding: 24 }}
                  >
                    No sessions recorded yet.
                  </td>
                </tr>
              ) : (
                visible.map((s) => {
                  const statusInfo = STATUS_CHIP[s.status] ?? STATUS_CHIP.planned;
                  return (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.scheduledDate}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.scheduledTime ?? "—"}
                      </td>
                      <td>{s.schoolCode ?? "—"}</td>
                      <td>{s.grade ?? "—"}</td>
                      <td>{s.subjectName ?? "—"}</td>
                      <td>{s.topic ?? "—"}</td>
                      <td>
                        {s.teacherName ?? "—"}
                        {s.teacherHindi ? (
                          <span
                            className="deva"
                            style={{
                              fontFamily: "var(--deva)",
                              color: "var(--ink-3)",
                              marginLeft: 6,
                              fontSize: 12,
                            }}
                          >
                            {s.teacherHindi}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className={`chip ${statusInfo.kind}`.trim()}>{statusInfo.label}</span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/repo/session/${s.id}`}
                          className="btn btn-sm btn-primary"
                          style={{ textDecoration: "none" }}
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
