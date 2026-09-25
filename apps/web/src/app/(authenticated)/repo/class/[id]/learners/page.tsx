// /repo/class/[id]/learners — PII-gated full roster (SM-9).
//
// Rules:
//   1. requireRole(["super_admin","programme_admin"]) — anyone else → /forbidden
//   2. recordAudit({action:"learners.view", ...}) fires BEFORE the DB read on every render
//      so the audit row exists even if the SELECT later errors.
//   3. The page reads learners.name + guardian + age + attendance% (the PII columns)
//      — that's why the audit is mandatory.

import { notFound } from "next/navigation";
import Link from "next/link";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, learners, schools } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { uuidOrNotFound } from "@/lib/ids";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export default async function RepoClassLearnersPage({ params }: { params: Promise<{ id: string }> }) {
  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);

  // SM-9 step 1: gate on role. Non-privileged callers never reach the audit hook OR the DB.
  await requireRole(["super_admin", "programme_admin"]);

  const [cls] = await db.select().from(classes).where(eq(classes.id, id)).limit(1);
  if (!cls) notFound();

  const [school] = await db.select().from(schools).where(eq(schools.id, cls.schoolId)).limit(1);

  // SM-9 step 2: audit-log this PII access BEFORE the SELECT. Fire-and-forget — a failed
  // audit insert never blocks the page render (mirrors admin/data/[entity] behaviour).
  void recordAudit({
    action: "learners.view",
    entityType: "class",
    entityId: id,
    metadata: { route: "/repo/class/[id]/learners", schoolId: cls.schoolId, grade: cls.grade },
  });

  const rows = await db
    .select({
      id: learners.id,
      name: learners.name,
      age: learners.age,
      guardian: learners.guardian,
      rollNumber: learners.rollNumber,
      section: learners.section,
      attendancePct: learners.attendancePct,
      active: learners.active,
    })
    .from(learners)
    .where(and(eq(learners.classId, id), isNull(learners.deletedAt)))
    .orderBy(asc(learners.rollNumber), asc(learners.name))
    .limit(80);

  return (
    <div>
      <div className="page-header">
        <Link
          href={`/repo/class/${id}`}
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8 }}
        >
          ← Grade {cls.grade}
        </Link>
        <div>
          <div className="label">Roster · {school?.code ?? "—"} · Grade {cls.grade}</div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Learners</h1>
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
            {rows.length} of {cls.studentsCount} on record. PII access is logged (SM-9): your view of
            this page is recorded in audit_log under <code className="mono">learners.view</code>.
          </p>
        </div>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ padding: 16 }}>
          {rows.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)", padding: 20, textAlign: "center" }}>
              No learners on record for this class.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>Roll</th>
                    <th>Name</th>
                    <th>Section</th>
                    <th>Age</th>
                    <th>Guardian</th>
                    <th>Attendance</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const att = r.attendancePct ?? null;
                    const attColor =
                      att == null
                        ? "var(--ink-3)"
                        : att >= 90
                          ? "var(--lichen)"
                          : att >= 75
                            ? "var(--ink-2)"
                            : "var(--rust)";
                    return (
                      <tr key={r.id}>
                        <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                          {r.rollNumber ?? "—"}
                        </td>
                        <td style={{ fontWeight: 500 }}>{r.name}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{r.section ?? "—"}</td>
                        <td style={{ fontSize: 12 }}>{r.age ?? "—"}</td>
                        <td style={{ fontSize: 12, color: "var(--ink-2)" }}>{r.guardian ?? "—"}</td>
                        <td
                          className="mono"
                          style={{ fontSize: 12, color: attColor, fontWeight: 600 }}
                        >
                          {att == null ? "—" : `${att}%`}
                        </td>
                        <td>
                          <span className={r.active ? "chip chip-lichen" : "chip"}>
                            <span className={r.active ? "dot dot-green" : "dot dot-gray"} />
                            {r.active ? "Active" : "Inactive"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 16, fontStyle: "italic" }}>
          Showing first 80 learners. For larger rosters, export via /admin/data/learners.
        </p>
      </div>
    </div>
  );
}
