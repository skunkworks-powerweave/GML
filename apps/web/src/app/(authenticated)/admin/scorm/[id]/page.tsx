// /admin/scorm/[id] -- one SCORM package's learners: status, score, time,
// sessions, first completion, last activity. Administrators only.
//
// The record is the SCO's own report (SCORM 1.2 is self-reported by
// design), keeping each learner's best status (lib/scorm/store.ts). Only
// learners who have launched the package have a row; the header counts them.
// An administrator who opened it as a learner has a row too, labelled, and is
// not counted.

import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@gml/db";
import { ADMIN_ROLES, hasAnyRole } from "@gml/shared/auth/roles";
import { requireRole } from "@/lib/guards";
import { uuidOrNotFound } from "@/lib/ids";
import { formatDuration, statusChip, statusLabel } from "@/lib/scorm/format";
import { packageSummary, packageTracking } from "@/lib/scorm/store";
import { setScormPackageActiveAction } from "../actions";

export const dynamic = "force-dynamic";

const when = (d: Date | null) =>
  d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "—";

export default async function ScormTrackingPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(["programme_admin", "super_admin"]);
  const id = uuidOrNotFound((await params).id);
  const pkg = await packageSummary(db, id);
  if (!pkg) notFound();
  const rows = await packageTracking(db, id);

  return (
    <main>
      <div className="page-header">
        <Link href="/admin/scorm" className="btn btn-sm btn-ghost">
          ← SCORM packages
        </Link>
        <div className="label" style={{ marginTop: 8 }}>
          {pkg.subject}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>{pkg.title}</h1>
          <span className={pkg.active ? "chip chip-lichen" : "chip chip-rust"}>{pkg.active ? "Active" : "Withdrawn"}</span>
        </div>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          {`${pkg.learners} ${pkg.learners === 1 ? "learner" : "learners"} · ${pkg.finished} finished`}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href={`/scorm/${pkg.id}`} className="btn btn-sm">
            Open as a learner
          </Link>
          <form action={setScormPackageActiveAction}>
            <input type="hidden" name="id" value={pkg.id} />
            <input type="hidden" name="active" value={pkg.active ? "false" : "true"} />
            <button type="submit" className="btn btn-sm btn-ghost">
              {pkg.active ? "Withdraw from learners" : "Restore for learners"}
            </button>
          </form>
        </div>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ overflowX: "auto" }}>
          <table className="t">
            <thead>
              <tr>
                <th>Learner</th>
                <th>Role</th>
                <th>Status</th>
                <th>Score</th>
                <th>Time</th>
                <th>Sessions</th>
                <th>First finished</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 36, textAlign: "center", color: "var(--ink-3)" }}>
                    Nobody has opened this package yet.
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
                      {r.role}
                      {hasAnyRole(r.role, ADMIN_ROLES) ? (
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>not counted</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={statusChip(r.lessonStatus)}>{statusLabel(r.lessonStatus)}</span>
                    </td>
                    <td className="mono">{r.scoreRaw === null ? "—" : String(r.scoreRaw)}</td>
                    <td className="mono">{formatDuration(r.totalTimeCs)}</td>
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
