// /admin/scorm -- every SCORM 1.2 package, with how many learners have a
// record of it and how many finished. Administrators only; each row opens
// that package's learner tracking.

import Link from "next/link";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { formatBytes } from "@/lib/scorm/format";
import { packageSummaries } from "@/lib/scorm/store";

export const dynamic = "force-dynamic";

export default async function ScormAdminPage() {
  await requireRole(["programme_admin", "super_admin"]);
  const packages = await packageSummaries(db);

  return (
    <main>
      <div className="page-header">
        <div className="label">RTT content</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: "4px 0 0" }}>SCORM packages</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640 }}>
          SCORM 1.2 modules, each launched from its RTT subject&apos;s page. Learners&apos; status, score and time are
          recorded as the module reports them.
        </p>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ overflowX: "auto" }}>
          <table className="t">
            <thead>
              <tr>
                <th>Package</th>
                <th>State</th>
                <th>Files</th>
                <th>Learners</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {packages.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 36, textAlign: "center", color: "var(--ink-3)" }}>
                    No SCORM packages yet.
                  </td>
                </tr>
              ) : (
                packages.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link
                        href={`/admin/scorm/${p.id}`}
                        style={{ color: "var(--ink)", fontFamily: "var(--serif)", fontSize: 16, textDecoration: "none" }}
                      >
                        {p.title}
                      </Link>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{p.subject}</div>
                    </td>
                    <td>
                      <span className={p.active ? "chip chip-lichen" : "chip chip-rust"}>{p.active ? "Active" : "Withdrawn"}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {`${p.fileCount} files · ${formatBytes(p.totalBytes)}`}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {`${p.learners} ${p.learners === 1 ? "learner" : "learners"} · ${p.finished} finished`}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {p.uploadedBy ?? "—"}
                      <div className="mono" style={{ color: "var(--ink-3)" }}>
                        {p.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                      </div>
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
