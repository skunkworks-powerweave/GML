// /repo/class/[id]/learners — PII-gated full roster (SM-9).
//
// Rules:
//   1. requireRole(["super_admin","programme_admin"]) — anyone else → /forbidden,
//      except a teacher: she reads the roster of a class she teaches, limited
//      to her own students (lib/teaching/visibility.ts); any other class is 404
//   2. recordAudit({action:"learners.view", ...}) fires BEFORE the DB read on every render
//      so the audit row exists even if the SELECT later errors.
//   3. The page reads learners.name + guardian + age + attendance% (the PII columns)
//      — that's why the audit is mandatory.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, learners, schools } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { uuidOrNotFound } from "@/lib/ids";
import { recordAudit } from "@/lib/audit";
import { auth } from "@/auth";
import { actorFrom } from "@/lib/authz";
import { learnersWhere, mayOpenClass, repoScope } from "@/lib/teaching/visibility";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("learners.metaTitle") };
}

export default async function RepoClassLearnersPage({ params }: { params: Promise<{ id: string }> }) {
  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);

  // SM-9 step 1: gate on role. Non-privileged callers never reach the audit hook OR the DB.
  // A teacher is let through to the ownership check below, which answers 404
  // for any class she does not teach before anything is read or audited.
  const signedIn = await auth();
  const actor = actorFrom(
    signedIn?.user?.role === "teacher" ? signedIn : await requireRole(["super_admin", "programme_admin"]),
  );
  if (!actor) notFound();
  const scope = await repoScope(db, actor);
  if (!mayOpenClass(scope, id)) notFound();

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
    .where(and(eq(learners.classId, id), isNull(learners.deletedAt), learnersWhere(scope, id)))
    .orderBy(asc(learners.rollNumber), asc(learners.name))
    .limit(80);

  const t = await getTranslations("repo");

  return (
    <div>
      <div className="page-header">
        <Link
          href={`/repo/class/${id}`}
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8 }}
        >
          {t("learners.back", { grade: cls.grade })}
        </Link>
        <div>
          <div className="label">{t("learners.label", { code: school?.code ?? "—", grade: cls.grade })}</div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{t("learners.title")}</h1>
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
            {t.rich("learners.intro", {
              shown: rows.length,
              total: cls.studentsCount,
              code: (chunks) => <code className="mono">{chunks}</code>,
            })}
          </p>
        </div>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ padding: 16 }}>
          {rows.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)", padding: 20, textAlign: "center" }}>
              {t("learners.empty")}
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("learners.roll")}</th>
                    <th>{t("common.name")}</th>
                    <th>{t("learners.section")}</th>
                    <th>{t("common.age")}</th>
                    <th>{t("common.guardian")}</th>
                    <th>{t("common.attendance")}</th>
                    <th>{t("common.status")}</th>
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
                            {r.active ? t("common.active") : t("common.inactive")}
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
          {t("learners.footnote")}
        </p>
      </div>
    </div>
  );
}
