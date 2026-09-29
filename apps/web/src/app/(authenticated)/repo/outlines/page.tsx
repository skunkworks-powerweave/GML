// /repo/outlines — repository index of curriculum course outlines.
// Ports LMS GML Frontend/repository.jsx :: RepoOutlinesIndex (lines 565-599).
// Table by subject × grade × term with status pill; click-through to detail.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): add server-side
// filters for grade, term, and status. Each one is a URL searchParam so the
// filtered view is bookmarkable and the WHERE clause runs in Postgres.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { and, asc, eq, ilike, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { courseOutlines, subjects, teachers } from "@gml/db/schema";
// Spec 138 — mobile card-list fallback (desktop keeps the 9-col table).
import { getDeviceType } from "@/lib/device";
import { MobileRepoCardList } from "@/components/repo/MobileRepoCardList";
import { escapeIlike } from "@gml/shared/sql/ilike";
import { enumLabel } from "@/components/repo/repo-i18n";
import { auth } from "@/auth";
import { actorFrom } from "@/lib/authz";
import { outlinesWhere, repoScope } from "@/lib/teaching/visibility";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("outlines.metaTitle") };
}

// The label is repo.outlineStatus.<status>, in the viewer's language.
const STATUS_CHIP: Record<string, { kind: string }> = {
  planned: { kind: "chip-ink" },
  in_progress: { kind: "chip-saffron" },
  complete: { kind: "chip-lichen" },
  archived: { kind: "" },
};

const STATUS_VALUES = new Set(["planned", "in_progress", "complete", "archived"]);

// Spec 158 — repo-search-bar contract: ?q= name filter, 200-char cap,
// escape ILIKE wildcards so a literal "%" / "_" in the query doesn't
// become a pattern character.
const SEARCH_Q_MAX = 200;

type SearchParams = Promise<{ grade?: string; term?: string; status?: string; q?: string }>;

export default async function RepoOutlinesIndexPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const actor = actorFrom(await auth());
  if (!actor) redirect("/login");
  // A teacher lists the approved programme outlines and her own lesson plans;
  // other teachers' plans are not hers to read (lib/teaching/visibility.ts).
  // Every other role lists every outline, as before.
  const own = outlinesWhere(await repoScope(db, actor));
  const sp = await searchParams;
  const t = await getTranslations("repo");
  const statusLabel = (status: string) => enumLabel(t, "outlineStatus", STATUS_CHIP[status] ? status : "planned");

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
  // Spec 158 — name search on courseOutlines.name.
  const qRaw = (sp.q ?? "").slice(0, SEARCH_Q_MAX);
  const qFilter = qRaw.trim().length > 0 ? qRaw.trim() : null;

  const conds: SQL[] = [];
  if (own) conds.push(own);
  if (gradeFilter !== null) conds.push(eq(courseOutlines.grade, gradeFilter));
  if (termFilter !== null) conds.push(eq(courseOutlines.term, termFilter));
  if (statusFilter !== null) conds.push(eq(courseOutlines.status, statusFilter));
  // Spec 158 — combine the new ?q= filter via and(...).
  if (qFilter) conds.push(ilike(courseOutlines.name, `%${escapeIlike(qFilter)}%`));

  const rows = await db
    .select({
      id: courseOutlines.id,
      name: courseOutlines.name,
      grade: courseOutlines.grade,
      term: courseOutlines.term,
      weeks: courseOutlines.weeks,
      sessionsCount: courseOutlines.sessionsCount,
      status: courseOutlines.status,
      approvalStatus: courseOutlines.approvalStatus,
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
        <div className="label">{t("common.repository")}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{t("outlines.title")}</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          {t("outlines.intro")}
        </p>
      </div>
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <form
          method="GET"
          action="/repo/outlines"
          className="card"
          style={{ padding: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          {/* Spec 158 — name search input. Submits alongside grade/term/
              status so a single Apply call refreshes the URL state. */}
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            {t("common.name")}
            <input
              type="search"
              name="q"
              defaultValue={qFilter ?? ""}
              aria-label={t("outlines.searchLabel")}
              title={t("outlines.searchLabel")}
              maxLength={SEARCH_Q_MAX}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12, minWidth: 160 }}
            />
          </label>
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            {t("common.grade")}
            <select
              name="grade"
              defaultValue={gradeFilter === null ? "" : String(gradeFilter)}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="">{t("common.all")}</option>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            {t("common.term")}
            <select
              name="term"
              defaultValue={termFilter === null ? "" : String(termFilter)}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="">{t("common.all")}</option>
              {[1, 2, 3, 4, 5, 6].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            {t("common.status")}
            <select
              name="status"
              defaultValue={statusFilter ?? ""}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="">{t("common.all")}</option>
              {Object.keys(STATUS_CHIP).map((v) => (
                <option key={v} value={v}>
                  {statusLabel(v)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-sm">
            {t("common.apply")}
          </button>
          {(gradeFilter !== null || termFilter !== null || statusFilter !== null || qFilter) ? (
            <Link
              href="/repo/outlines"
              className="btn btn-sm"
              style={{ textDecoration: "none" }}
            >
              {t("common.clear")}
            </Link>
          ) : null}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{t("common.shown", { count: rows.length })}</span>
          </div>
        </form>
        {/* Spec 138 — mobile branch: card list. Desktop keeps the table. */}
        {device === "mobile" ? (
          <MobileRepoCardList
            testIdSuffix="outlines"
            emptyMessage={t("outlines.empty")}
            items={rows.map((o) => {
              const chip = STATUS_CHIP[o.status] ?? STATUS_CHIP.planned;
              return {
                id: o.id,
                primary: o.name,
                hindi: o.ownerHindi ?? null,
                href: `/repo/outline/${o.id}`,
                chip: { label: statusLabel(o.status), kind: chip.kind },
                secondary: [
                  { label: t("common.subject"), value: o.subjectName ?? "—" },
                  {
                    value: o.weeks
                      ? t("outlines.cardMetaWeeks", { grade: o.grade, term: o.term, sessions: o.sessionsCount, weeks: o.weeks })
                      : t("outlines.cardMeta", { grade: o.grade, term: o.term, sessions: o.sessionsCount }),
                  },
                  o.ownerName ? { label: t("common.owner"), value: o.ownerName } : { value: "—" },
                  ...(o.approvalStatus !== "approved" ? [{ value: enumLabel(t, "approval", o.approvalStatus) }] : []),
                ],
              };
            })}
          />
        ) : null}
        <div className="card card-hi" style={device === "mobile" ? { display: "none", overflow: "hidden" } : { overflow: "hidden" }} aria-hidden={device === "mobile"}>
          {rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
              {t("outlines.empty")}
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>{t("common.outline")}</th>
                  <th>{t("common.subject")}</th>
                  <th>{t("common.grade")}</th>
                  <th>{t("common.term")}</th>
                  <th>{t("common.sessions")}</th>
                  <th>{t("common.weeks")}</th>
                  <th>{t("common.owner")}</th>
                  <th>{t("common.status")}</th>
                  <th aria-label={t("outlines.openColumn")} />
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
                        <span className={`chip ${chip.kind}`.trim()}>{statusLabel(o.status)}</span>
                        {o.approvalStatus !== "approved" ? (
                          <span className="chip chip-saffron" style={{ marginLeft: 4 }}>
                            {enumLabel(t, "approval", o.approvalStatus)}
                          </span>
                        ) : null}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/repo/outline/${o.id}`}
                          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
                          aria-label={t("common.openRecord", { name: o.name })}
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
