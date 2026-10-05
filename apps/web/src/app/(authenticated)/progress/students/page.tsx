// /progress/students -- the programme's student progress, for programme admins
// and super admins: each school, its classes, and for every class the number
// of students, the sessions held of those planned, the attendance rate and the
// average marks. A class opens on its own page with a row per student
// (./[classId]/page.tsx).
//
// Narrowed by district and zone (the picker /rtt uses) and by school, a page of
// schools at a time. The numbers are lib/teaching/progress.ts, the same
// definitions a teacher's page uses, over every teacher's sessions and tests.
// No student is named here, so this page writes no learner audit; the class
// page does. Mentors, observers and teachers are not given it: no rule gives
// them every school's learner data (a teacher has /teaching/progress).

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { isUuid } from "@/lib/ids";
import { placeOptions, resolvePlace } from "@/lib/rtt/scope";
import { programmeProgress, schoolChoices } from "@/lib/teaching/progress";
import { PlacePicker } from "../../rtt/place-picker";
import { Card, Empty, listRow, mutedText, PageHeader, wrapRow } from "../../teaching/_components/ui";
import { FigureFacts, RuleNote } from "../../teaching/_components/progress";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("progress.title") };
}

type SearchParams = Promise<{ district?: string; zone?: string; school?: string; page?: string }>;

export default async function ProgressOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  await requireRole(["programme_admin", "super_admin"]);
  const t = await getTranslations("teaching");
  const sp = await searchParams;
  // A malformed filter names nothing and is ignored, as /repo/students does.
  const place = await resolvePlace(db, sp);
  const schoolId = isUuid(sp.school) ? sp.school : null;

  const [options, choices, overview] = await Promise.all([
    placeOptions(db),
    schoolChoices(db, place),
    programmeProgress(db, { place, schoolId, page: Number(sp.page) || 1 }),
  ]);

  const href = (page: number) => {
    const q = new URLSearchParams();
    if (place) q.set(place.zoneId ? "zone" : "district", place.zoneId ?? place.districtId);
    if (schoolId) q.set("school", schoolId);
    if (page > 1) q.set("page", String(page));
    const s = q.toString();
    return s ? `/progress/students?${s}` : "/progress/students";
  };

  return (
    <div>
      <PageHeader label={t("progress.admin.label")} title={t("progress.title")} intro={t("progress.admin.intro")} />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <RuleNote t={t} />

        <div style={{ display: "grid", gap: 8 }}>
          <PlacePicker basePath="/progress/students" options={options} place={place} />
          <form method="GET" action="/progress/students" style={{ ...wrapRow, alignItems: "flex-end" }}>
            {place ? <input type="hidden" name={place.zoneId ? "zone" : "district"} value={place.zoneId ?? place.districtId} /> : null}
            <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
              <span className="label">{t("progress.admin.schoolFilter")}</span>
              <select name="school" className="text" defaultValue={schoolId ?? ""} style={{ maxWidth: "100%" }}>
                <option value="">{t("progress.admin.allSchools")}</option>
                {choices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-sm">
              {t("progress.admin.show")}
            </button>
          </form>
        </div>

        {overview.schools.length === 0 ? (
          <section className="card card-hi" style={{ padding: 16 }}>
            <Empty>{t("progress.admin.noSchools")}</Empty>
          </section>
        ) : null}

        {overview.schools.map((school) => (
          <Card
            key={school.id}
            title={school.name}
            sub={t("progress.admin.schoolSub", { code: school.code, district: school.districtName, zone: school.zoneName })}
          >
            {school.classes.length === 0 ? (
              <Empty>{t("progress.admin.noClasses")}</Empty>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                <li style={{ ...listRow, display: "grid", gap: 6 }}>
                  <div style={{ fontWeight: 600 }}>{t("progress.admin.allClasses")}</div>
                  <FigureFacts t={t} figures={school.totals} />
                </li>
                {school.classes.map((c) => (
                  <li key={c.classId} style={{ ...listRow, display: "grid", gap: 6 }}>
                    <div style={{ ...wrapRow, justifyContent: "space-between" }}>
                      <Link href={`/progress/students/${c.classId}`} style={{ fontWeight: 600, color: "var(--ink)" }}>
                        {t("common.gradeN", { grade: c.grade })}
                      </Link>
                      <Link href={`/progress/students/${c.classId}`} className="btn btn-sm">
                        {t("progress.admin.open")}
                      </Link>
                    </div>
                    <FigureFacts t={t} figures={c.figures} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}

        {overview.pages > 1 ? (
          <nav style={{ ...wrapRow, justifyContent: "space-between" }}>
            {overview.page > 1 ? (
              <Link href={href(overview.page - 1)} className="btn btn-sm">
                {t("progress.admin.prev")}
              </Link>
            ) : (
              <span />
            )}
            <span style={mutedText}>{t("progress.admin.page", { page: overview.page, pages: overview.pages })}</span>
            {overview.page < overview.pages ? (
              <Link href={href(overview.page + 1)} className="btn btn-sm">
                {t("progress.admin.next")}
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
