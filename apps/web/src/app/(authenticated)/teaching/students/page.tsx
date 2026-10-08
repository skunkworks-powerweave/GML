// /teaching/students -- "My students": the learners of the classes a teacher
// teaches, class by class, with their roll number, section, age and guardian.
// She adds, edits and removes them here; the actions re-check that each one
// is hers (./actions.ts). A CSV adds many at once (./students-csv.ts). Learner
// details are PII: rendering this list is audited (teaching.students.viewed),
// as every learner list is (SM-9).

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { actorFrom } from "@/lib/visibility";
import { myTeacher } from "@/lib/teaching";
import { myStudentsByLink, type StudentRow } from "@/lib/teaching/records";
import { SubmitButton } from "@/components/SubmitButton";
import { ActionForm } from "../_components/ActionForm";
import { Card, classLabel, Empty, Field, fieldGrid, listRow, mutedText, NoTeacherRecord, PageHeader, wrapRow, type Translate } from "../_components/ui";
import { addStudentAction, removeStudentAction, updateStudentAction } from "./actions";
import { uploadStudentsCsvAction } from "./students-csv";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("students.title") };
}

/** Name, roll number, age and guardian: the same fields in the add and the edit form. */
function StudentFields({ t, s }: { t: Translate; s?: StudentRow }) {
  return (
    <div style={fieldGrid}>
      <Field label={t("fields.name")}>
        <input name="name" className="text" required maxLength={160} defaultValue={s?.name ?? ""} autoComplete="off" />
      </Field>
      <Field label={t("fields.rollNumber")}>
        <input name="rollNumber" className="text" maxLength={32} defaultValue={s?.rollNumber ?? ""} autoComplete="off" />
      </Field>
      <Field label={t("fields.age")}>
        <input name="age" className="text" type="number" min={3} max={25} defaultValue={s?.age ?? ""} />
      </Field>
      <Field label={t("fields.guardian")}>
        <input name="guardian" className="text" maxLength={120} defaultValue={s?.guardian ?? ""} autoComplete="off" />
      </Field>
    </div>
  );
}

export default async function MyStudentsPage() {
  const session = await requireRole(["teacher"]);
  const actor = actorFrom(session)!;
  const teacher = await myTeacher(db, actor);
  if (!teacher) return <NoTeacherRecord />;
  const t = await getTranslations("teaching");

  const groups = await myStudentsByLink(db, teacher.id);
  const rowCount = groups.reduce((n, g) => n + g.students.length, 0);
  void recordAudit({
    action: "teaching.students.viewed",
    entityType: "teacher",
    entityId: teacher.id,
    userId: actor.id,
    metadata: { page: "students", rowCount },
  });

  return (
    <div>
      <PageHeader label={t("hub.label")} title={t("students.title")} intro={t("students.intro")} back={{ href: "/teaching", text: t("hub.title") }} />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {groups.length === 0 ? (
          <section className="card card-hi" style={{ padding: 16, display: "grid", gap: 10 }}>
            <Empty>{t("students.noClasses")}</Empty>
            <div>
              <Link href="/teaching/classes" className="btn btn-sm">
                {t("hub.links.classes")}
              </Link>
            </div>
          </section>
        ) : null}
        {groups.length > 0 ? (
          <Card title={t("students.csvTitle")}>
            <p style={{ ...mutedText, margin: 0 }}>{t("students.csvIntro")}</p>
            <p style={{ ...mutedText, margin: 0 }}>
              {t("students.csvClasses", { classes: groups.map(({ link }) => classLabel(t, link.grade, link.section)).join(", ") })}
            </p>
            <div style={wrapRow}>
              <a className="btn btn-sm" href="/api/teaching/students/template" download>
                {t("students.template")}
              </a>
            </div>
            <ActionForm action={uploadStudentsCsvAction}>
              <Field label={t("students.csvFile")}>
                <input type="file" name="file" accept=".csv,text/csv" required />
              </Field>
              <div>
                <SubmitButton className="btn btn-primary">{t("students.csvSubmit")}</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        ) : null}
        {groups.map(({ link, students }) => (
          <Card
            key={link.linkId}
            id={`class-${link.linkId}`}
            title={classLabel(t, link.grade, link.section)}
            sub={t("students.count", { count: students.length })}
          >
            {students.length === 0 ? (
              <Empty>{t("students.empty")}</Empty>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                {students.map((s) => (
                  <li key={s.id} style={{ ...listRow, display: "grid", gap: 6 }}>
                    <div style={{ ...wrapRow, justifyContent: "space-between" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{s.name}</div>
                        <div style={mutedText}>
                          {[
                            s.rollNumber ? t("students.roll", { roll: s.rollNumber }) : null,
                            s.section ? t("students.section", { section: s.section }) : null,
                            s.age != null ? t("students.age", { age: s.age }) : null,
                            s.guardian ? t("students.guardian", { guardian: s.guardian }) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                    </div>
                    <details>
                      <summary style={{ cursor: "pointer", fontSize: 13 }}>{t("students.edit")}</summary>
                      <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
                        <ActionForm action={updateStudentAction}>
                          <input type="hidden" name="learnerId" value={s.id} />
                          <StudentFields t={t} s={s} />
                          <Field label={t("fields.sectionOptional")} hint={link.section ? t("students.sectionFixed", { section: link.section }) : undefined}>
                            <input name="section" className="text" maxLength={8} defaultValue={s.section ?? ""} autoComplete="off" />
                          </Field>
                          <div>
                            <SubmitButton className="btn btn-primary btn-sm">{t("common.save")}</SubmitButton>
                          </div>
                        </ActionForm>
                        <ActionForm action={removeStudentAction}>
                          <input type="hidden" name="learnerId" value={s.id} />
                          <p style={{ ...mutedText, margin: 0 }}>{t("students.removeHint")}</p>
                          <div>
                            <SubmitButton className="btn btn-sm">{t("students.remove")}</SubmitButton>
                          </div>
                        </ActionForm>
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="btn btn-sm" style={{ listStyle: "none", cursor: "pointer", display: "inline-flex" }}>
                {t("students.add")}
              </summary>
              <ActionForm action={addStudentAction} style={{ marginTop: 10 }}>
                <input type="hidden" name="linkId" value={link.linkId} />
                <StudentFields t={t} />
                {link.section ? (
                  <p style={{ ...mutedText, margin: 0 }}>{t("students.sectionFixed", { section: link.section })}</p>
                ) : (
                  <Field label={t("fields.sectionOptional")}>
                    <input name="section" className="text" maxLength={8} autoComplete="off" />
                  </Field>
                )}
                <div>
                  <SubmitButton className="btn btn-primary">{t("students.addSubmit")}</SubmitButton>
                </div>
              </ActionForm>
            </details>
          </Card>
        ))}
      </div>
    </div>
  );
}
