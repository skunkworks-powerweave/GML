// The "My teaching" card on a teacher's dashboard: her counts, what came back
// from an approver, and the way into /teaching. Built (awaited) by the
// dashboard page rather than rendered as an async component, so the page stays
// one render. Nothing for a teacher account with no teachers row: the hub
// explains that one.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { myTeacher } from "@/lib/teaching";
import { hubCounts, returnedRecords } from "@/lib/teaching/records";

export async function myTeachingCard(userId: string) {
  const teacher = await myTeacher(db, { id: userId, role: "teacher" });
  if (!teacher) return null;
  const t = await getTranslations("teaching");
  const [counts, returned] = await Promise.all([hubCounts(db, teacher.id), returnedRecords(db, teacher.id)]);
  return (
    <article className="card card-hi" data-card="my-teaching">
      <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
        <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
          {t("dashboard.title")}
        </h2>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
          {t("dashboard.summary", { classes: counts.classes, students: counts.students, plans: counts.plans, sessions: counts.sessions })}
        </div>
      </header>
      <div style={{ padding: 14, display: "grid", gap: 8, fontSize: 13 }}>
        {returned.length > 0 ? (
          <Link href="/teaching" style={{ color: "var(--rust)" }}>
            {t("dashboard.returned", { count: returned.length })}
          </Link>
        ) : null}
        {counts.pending > 0 ? <div style={{ color: "var(--ink-2)" }}>{t("hub.pending", { count: counts.pending })}</div> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Link href="/teaching" className="btn btn-sm">
            {t("dashboard.open")}
          </Link>
          <Link href="/teaching/sessions" className="btn btn-sm btn-ghost">
            {t("hub.links.sessions")}
          </Link>
          <Link href="/teaching/progress" className="btn btn-sm btn-ghost">
            {t("hub.links.progress")}
          </Link>
        </div>
      </div>
    </article>
  );
}
