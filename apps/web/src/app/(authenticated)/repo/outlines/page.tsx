// /repo/outlines — repository index of curriculum course outlines.
// Ports LMS GML Frontend/repository.jsx :: RepoOutlinesIndex (lines 565-599).
// Table by subject × grade × term with status pill; click-through to detail.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): add server-side
// filters for grade, term, and status. Each one is a URL searchParam so the
// filtered view is bookmarkable and the WHERE clause runs in Postgres.

import Link from "next/link";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { courseOutlines, subjects, teachers } from "@gml/db/schema";
// Spec 138 — mobile card-list fallback (desktop keeps the 9-col table).
import { getDeviceType } from "@/lib/device";
import { MobileRepoCardList } from "@/components/repo/MobileRepoCardList";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<string, { kind: string; label: string }> = {
  planned: { kind: "chip-ink", label: "Planned" },
  in_progress: { kind: "chip-saffron", label: "In progress" },
  complete: { kind: "chip-lichen", label: "Complete" },
  archived: { kind: "", label: "Archived" },
};

const STATUS_VALUES = new Set(["planned", "in_progress", "complete", "archived"]);

type SearchParams = Promise<{ grade?: string; term?: string; status?: string }>;

export default async function RepoOutlinesIndexPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;

  const gradeParsed = Number(sp.grade);
  const gradeFilter =
    Number.isInteger(gradeParsed) && gradeParsed >= 1 && gradeParsed <= 12
      ? gradeParsed
      : null;

  const termParsed = Number(sp.term);
  const termFilter =
    Number.isInteger(termParsed) && termParsed >= 1 && termParsed <= 6
      ? termParsed
      : null;

  const statusFilter = STATUS_VALUES.has(sp.status ?? "") ? sp.status! : null;

  const conds: SQL[] = [];
  if (gradeFilter !== null) conds.push(eq(courseOutlines.grade, gradeFilter));
  if (termFilter !== null) conds.push(eq(courseOutlines.term, termFilter));
  if (statusFilter !== null) conds.push(eq(courseOutlines.status, statusFilter));

  const rows = await db
    .select({
      id: courseOutlines.id,
      name: courseOutlines.name,
      grade: courseOutlines.grade,
      term: courseOutlines.term,
      weeks: courseOutlines.weeks,
      sessionsCount: courseOutlines.sessionsCount,
      status: courseOutlines.status,
      subjectName: subjects.name,
      subjectColor: subjects.color,
      ownerName: teachers.fullName,
      ownerHindi: teachers.hindiName,
    })
    .from(courseOutlines)
    .leftJoin(subjects, eq(courseOutlines.subjectId, subjects.id))
    .leftJoin(teachers, eq(courseOutlines.ownerTeacherId, teachers.id))
    .where(conds.length === 0 ? undefined : and(...conds))
    .orderBy(asc(subjects.name), asc(courseOutlines.grade), asc(courseOutlines.term))
    .limit(200);

  // Spec 138 — device-aware card/table fork.
  const device = await getDeviceType();

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Course outlines</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          Term-level units per subject × grade. Each outline holds the learning outcomes, weekly lessons and the
          sessions delivered against it.
        </p>
      </div>
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <form
          method="GET"
          action="/repo/outlines"
          className="card"
          style={{ padding: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            Grade
            <select
              name="grade"
              defaultValue={gradeFilter === null ? "" : String(gradeFilter)}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="">All</option>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            Term
            <select
              name="term"
              defaultValue={termFilter === null ? "" : String(termFilter)}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="">All</option>
              {[1, 2, 3, 4, 5, 6].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            Status
            <select
              name="status"
              defaultValue={statusFilter ?? ""}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="">All</option>
              {Object.entries(STATUS_CHIP).map(([v, info]) => (
                <option key={v} value={v}>
                  {info.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-sm">
            Apply
          </button>
          {(gradeFilter !== null || termFilter !== null || statusFilter !== null) ? (
            <Link
              href="/repo/outlines"
              className="btn btn-sm"
              style={{ textDecoration: "none" }}
            >
              Reset
            </Link>
          ) : null}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{rows.length} shown</span>
          </div>
        </form>
        {/* Spec 138 — mobile branch: card list. Desktop keeps the table. */}
        {device === "mobile" ? (
          <MobileRepoCardList
            testIdSuffix="outlines"
            emptyMessage="No outlines match this filter."
            items={rows.map((o) => {
              const chip = STATUS_CHIP[o.status] ?? STATUS_CHIP.planned;
              return {
                id: o.id,
                primary: o.name,
                hindi: o.ownerHindi ?? null,
                href: `/repo/outline/${o.id}`,
                chip: { label: chip.label, kind: chip.kind },
                secondary: [
                  { label: "Subject", value: o.subjectName ?? "—" },
                  {
                    value: `Grade ${o.grade} · Term ${o.term} · ${o.sessionsCount} sessions${o.weeks ? ` · ${o.weeks} weeks` : ""}`,
                  },
                  o.ownerName ? { label: "Owner", value: o.ownerName } : { value: "—" },
                ],
              };
            })}
          />
        ) : null}
        <div className="card card-hi" style={device === "mobile" ? { display: "none", overflow: "hidden" } : { overflow: "hidden" }} aria-hidden={device === "mobile"}>
          {rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
              No outlines match this filter.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Outline</th>
                  <th>Subject</th>
                  <th>Grade</th>
                  <th>Term</th>
                  <th>Sessions</th>
                  <th>Weeks</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th aria-label="open" />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const chip = STATUS_CHIP[o.status] ?? STATUS_CHIP.planned;
                  return (
                    <tr key={o.id}>
                      <td style={{ fontWeight: 500 }}>
                        <Link
                          href={`/repo/outline/${o.id}`}
                          style={{ color: "var(--ink)", textDecoration: "none" }}
                        >
                          {o.name}
                        </Link>
                      </td>
                      <td>
                        {o.subjectName ?? <span style={{ color: "var(--ink-3)" }}>—</span>}
                      </td>
                      <td>{o.grade}</td>
                      <td>{o.term}</td>
                      <td>{o.sessionsCount}</td>
                      <td>{o.weeks ?? <span style={{ color: "var(--ink-3)" }}>—</span>}</td>
                      <td>
                        {o.ownerName ? (
                          <>
                            {o.ownerName}
                            {o.ownerHindi ? (
                              <span
                                className="deva"
                                style={{ color: "var(--ink-3)", marginLeft: 6, fontSize: 12, fontFamily: "var(--deva)" }}
                              >
                                {o.ownerHindi}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span style={{ color: "var(--ink-3)" }}>—</span>
                        )}
                      </td>
                      <td>
                        <span className={`chip ${chip.kind}`.trim()}>{chip.label}</span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/repo/outline/${o.id}`}
                          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
                          aria-label={`Open ${o.name}`}
                        >
                          ›
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
