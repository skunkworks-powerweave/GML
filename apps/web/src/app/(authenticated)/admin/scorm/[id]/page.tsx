// /admin/scorm/[id] -- one SCORM package's learners: status, score, time,
// sessions, first completion, last activity. Administrators only.
//
// The record is the SCO's own report (SCORM 1.2 is self-reported by
// design), keeping each learner's best status (lib/scorm/store.ts). Only
// learners who have launched the package have a row; the header counts them.
// An administrator who opened it as a learner has a row too, labelled, and is
// not counted.
//
// Words, dates and roles are in the user's language (adminData.scorm.tracking,
// INTL_LOCALE). A record's status words and time are the ones the learner's
// own pages use -- lib/scorm/format.ts, rtt.scorm.* -- handed this page's
// translator for that namespace, so the two never describe a record
// differently. Names and scores are data.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { ADMIN_ROLES, ROLES, hasAnyRole } from "@gml/shared/auth/roles";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";
import { requireRole } from "@/lib/guards";
import { uuidOrNotFound } from "@/lib/ids";
import { formatDuration, statusChip, statusLabel, type RttTranslate } from "@/lib/scorm/format";
import { packageSummary, packageTracking } from "@/lib/scorm/store";
import { setScormPackageActiveAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ScormTrackingPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(["programme_admin", "super_admin"]);
  const id = uuidOrNotFound((await params).id);
  const pkg = await packageSummary(db, id);
  if (!pkg) notFound();
  const rows = await packageTracking(db, id);
  const t = await getTranslations("adminData");
  const tScorm = (await getTranslations("rtt")) as unknown as RttTranslate;
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  const when = (d: Date | null) =>
    // i18n-ignore: an IANA time zone id
    d ? d.toLocaleString(intl, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "—";
  const role = (r: string) => ((ROLES as readonly string[]).includes(r) ? t(`scorm.tracking.role.${r}`) : r);

  return (
    <main>
      <div className="page-header">
        <Link href="/admin/scorm" className="btn btn-sm btn-ghost">
          {t("scorm.tracking.back")}
        </Link>
        <div className="label" style={{ marginTop: 8 }}>
          {pkg.subject}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>{pkg.title}</h1>
          <span className={pkg.active ? "chip chip-lichen" : "chip chip-rust"}>
            {pkg.active ? t("scorm.active") : t("scorm.withdrawn")}
          </span>
        </div>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          {t("scorm.learners", { count: pkg.learners, finished: String(pkg.finished) })}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href={`/scorm/${pkg.id}`} className="btn btn-sm">
            {t("scorm.tracking.openAsLearner")}
          </Link>
          <form action={setScormPackageActiveAction}>
            <input type="hidden" name="id" value={pkg.id} />
            <input type="hidden" name="active" value={pkg.active ? "false" : "true"} />
            <button type="submit" className="btn btn-sm btn-ghost">
              {pkg.active ? t("scorm.tracking.withdraw") : t("scorm.tracking.restore")}
            </button>
          </form>
        </div>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ overflowX: "auto" }}>
          <table className="t">
            <thead>
              <tr>
                <th>{t("scorm.tracking.columns.learner")}</th>
                <th>{t("scorm.tracking.columns.role")}</th>
                <th>{t("scorm.tracking.columns.status")}</th>
                <th>{t("scorm.tracking.columns.score")}</th>
                <th>{t("scorm.tracking.columns.time")}</th>
                <th>{t("scorm.tracking.columns.sessions")}</th>
                <th>{t("scorm.tracking.columns.firstFinished")}</th>
                <th>{t("scorm.tracking.columns.lastActivity")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 36, textAlign: "center", color: "var(--ink-3)" }}>
                    {t("scorm.tracking.empty")}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.userId}>
                    <td>
                      <div>{r.name ?? r.email ?? r.userId}</div>
                      {r.name && r.email ? <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.email}</div> : null}
                    </td>
                    <td>
                      {role(r.role)}
                      {hasAnyRole(r.role, ADMIN_ROLES) ? (
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{t("scorm.tracking.notCounted")}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={statusChip(r.lessonStatus)}>{statusLabel(r.lessonStatus, tScorm)}</span>
                    </td>
                    <td className="mono">{r.scoreRaw === null ? "—" : String(r.scoreRaw)}</td>
                    <td className="mono">{formatDuration(r.totalTimeCs, tScorm)}</td>
                    <td className="mono">{r.sessionCount}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {when(r.completedAt)}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {when(r.updatedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
