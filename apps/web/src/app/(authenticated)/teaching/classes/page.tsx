// /teaching/classes -- "My classes": the grades (and sections) a teacher
// teaches at her school, and the subject she teaches each. She adds a class
// from scratch here and removes her link to one; the class itself, its
// students and its sessions stay. Her own links only (lib/teaching).

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { schools } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/visibility";
import { myTeacher } from "@/lib/teaching";
import { activeSubjects, myLinks } from "@/lib/teaching/records";
import { SubmitButton } from "@/components/SubmitButton";
import { ActionForm } from "../_components/ActionForm";
import { Card, classLabel, Empty, Field, fieldGrid, listRow, mutedText, NoTeacherRecord, PageHeader, wrapRow } from "../_components/ui";
import { addClassAction, removeClassAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("classes.title") };
}

const GRADES = Array.from({ length: 12 }, (_, i) => i + 1);

export default async function MyClassesPage() {
  const session = await requireRole(["teacher"]);
  const actor = actorFrom(session)!;
  const teacher = await myTeacher(db, actor);
  if (!teacher) return <NoTeacherRecord />;
  const t = await getTranslations("teaching");

  const [links, subjectRows, [school]] = await Promise.all([
    myLinks(db, teacher.id),
    activeSubjects(db),
    db.select({ name: schools.name }).from(schools).where(eq(schools.id, teacher.schoolId)).limit(1),
  ]);

  return (
    <div>
      <PageHeader
        label={t("hub.label")}
        title={t("classes.title")}
        intro={t("classes.intro", { school: school?.name ?? "" })}
        back={{ href: "/teaching", text: t("hub.title") }}
      />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <Card title={t("classes.listTitle", { count: links.length })}>
          {links.length === 0 ? (
            <Empty>{t("classes.empty")}</Empty>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              {links.map((l) => (
                <li key={l.linkId} style={listRow}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{classLabel(t, l.grade, l.section)}</div>
                    <div style={mutedText}>
                      {l.subjectName ? t("classes.teaches", { subject: l.subjectName }) : t("classes.anySubject")}
                      {" · "}
                      {t.has(`stage.${l.stage.toLowerCase()}`) ? t(`stage.${l.stage.toLowerCase()}`) : l.stage}
                    </div>
                  </div>
                  <div style={wrapRow}>
                    <Link href={`/teaching/students#class-${l.linkId}`} className="btn btn-sm">
                      {t("classes.students")}
                    </Link>
                    <details>
                      <summary className="btn btn-sm btn-ghost" style={{ listStyle: "none", cursor: "pointer" }}>
                        {t("classes.remove")}
                      </summary>
                      <ActionForm action={removeClassAction} style={{ marginTop: 8 }}>
                        <input type="hidden" name="linkId" value={l.linkId} />
                        <p style={{ ...mutedText, margin: 0 }}>{t("classes.removeConfirm")}</p>
                        <div>
                          <SubmitButton className="btn btn-sm">{t("classes.removeYes")}</SubmitButton>
                        </div>
                      </ActionForm>
                    </details>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("classes.addTitle")} sub={t("classes.addSub")}>
          <ActionForm action={addClassAction}>
            <div style={fieldGrid}>
              <Field label={t("fields.grade")}>
                <select name="grade" className="text" required defaultValue="">
                  <option value="" disabled>
                    {t("common.choose")}
                  </option>
                  {GRADES.map((g) => (
                    <option key={g} value={g}>
                      {t("common.gradeN", { grade: g })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("fields.sectionOptional")} hint={t("classes.sectionHint")}>
                <input name="section" className="text" maxLength={8} autoComplete="off" />
              </Field>
              <Field label={t("fields.subjectOptional")}>
                <select name="subjectId" className="text" defaultValue="">
                  <option value="">{t("classes.anySubject")}</option>
                  {subjectRows.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div>
              <SubmitButton className="btn btn-primary">{t("classes.add")}</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
