// /teaching -- "My teaching", a teacher's own records at a glance: how many
// classes, students, lesson plans and sessions she keeps, what is waiting for
// approval, and what an approver sent back, with the approver's comment and a
// link to fix it. Her records only (lib/teaching); a teacher account with no
// teachers row gets the explanation instead.

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/visibility";
import { latestApprovals } from "@/lib/approvals";
import { myTeacher } from "@/lib/teaching";
import { hubCounts, returnedRecords, type Returned } from "@/lib/teaching/records";
import { Card, Empty, listRow, mutedText, NoTeacherRecord, PageHeader, StateChip, wrapRow } from "./_components/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("hub.title") };
}

const SECTIONS = [
  { key: "classes", href: "/teaching/classes" },
  { key: "students", href: "/teaching/students" },
  { key: "plans", href: "/teaching/plans" },
  { key: "sessions", href: "/teaching/sessions" },
  { key: "marks", href: "/teaching/marks" },
] as const;

export default async function TeachingHubPage() {
  const session = await requireRole(["teacher"]);
  const actor = actorFrom(session)!;
  const teacher = await myTeacher(db, actor);
  if (!teacher) return <NoTeacherRecord />;
  const t = await getTranslations("teaching");

  const [counts, returned] = await Promise.all([hubCounts(db, teacher.id), returnedRecords(db, teacher.id)]);
  const comments = new Map<string, string | null>();
  for (const kind of ["session", "lesson_plan", "assessment"] as const) {
    const ids = returned.filter((r) => r.kind === kind).map((r) => r.id);
    for (const [itemId, a] of await latestApprovals(db, kind, ids)) comments.set(`${kind}:${itemId}`, a.comment);
  }

  return (
    <div>
      <PageHeader label={t("hub.label")} title={t("hub.title")} intro={t("hub.intro", { name: teacher.name })} />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <section style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
          {SECTIONS.map((s) => (
            <Link key={s.key} href={s.href} className="card card-hi" style={{ padding: 14, color: "var(--ink)", textDecoration: "none", display: "block" }}>
              <div className="label">{t(`hub.stats.${s.key}`)}</div>
              <div className="serif" style={{ fontSize: 30, marginTop: 6 }}>
                {counts[s.key]}
              </div>
              <div style={{ ...mutedText, fontSize: 11, marginTop: 2 }}>{t(`hub.links.${s.key}`)} →</div>
            </Link>
          ))}
        </section>

        <Card title={t("hub.returnedTitle", { count: returned.length })} sub={t("hub.returnedSub")}>
          {returned.length === 0 ? (
            <Empty>{t("hub.returnedEmpty")}</Empty>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              {returned.map((r: Returned) => {
                const comment = comments.get(`${r.kind}:${r.id}`);
                return (
                  <li key={`${r.kind}:${r.id}`} style={{ ...listRow, display: "grid", gap: 6 }}>
                    <div style={{ ...wrapRow, justifyContent: "space-between" }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="label">{t(`kinds.${r.kind}`)}</div>
                        <Link href={r.href} style={{ fontWeight: 600, color: "var(--ink)", overflowWrap: "anywhere" }}>
                          {r.title || t("sessions.untitled")}
                        </Link>
                      </div>
                      <StateChip t={t} state={r.state} />
                    </div>
                    {comment ? (
                      <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {t("hub.comment", { comment })}
                      </p>
                    ) : null}
                    <div>
                      <Link href={r.href} className="btn btn-sm">
                        {t("hub.fix")}
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title={t("hub.pendingTitle")}>
          <p style={{ margin: 0, fontSize: 13 }}>{t("hub.pending", { count: counts.pending })}</p>
        </Card>
      </div>
    </div>
  );
}
