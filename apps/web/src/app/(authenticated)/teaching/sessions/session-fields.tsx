// The fields of the session form, shared by "Plan a session" (./page.tsx) and
// the edit form (./[id]/page.tsx). Choices are hers only: her class links, the
// active subjects, and lessons from her plans or the programme's outlines for
// the grades she teaches. The action re-checks every one (./actions.ts).

import type { HerLink, LessonChoice } from "@/lib/teaching/records";
import { SESSION_STATUSES } from "@/lib/teaching/records";
import { classLabel, Field, fieldGrid, type Translate } from "../_components/ui";

export type SessionDefaults = {
  linkId?: string;
  section?: string | null;
  subjectId?: string;
  lessonId?: string | null;
  date?: string;
  time?: string | null;
  durationMin?: number | null;
  topic?: string | null;
  notes?: string | null;
  status?: string;
};

export function SessionFields({
  t,
  links,
  subjects,
  lessons,
  d = {},
}: {
  t: Translate;
  links: HerLink[];
  subjects: Array<{ id: string; name: string }>;
  lessons: LessonChoice[];
  d?: SessionDefaults;
}) {
  // One <optgroup> per outline, in the order lessonChoices returns them.
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  const groups = new Map<string, { label: string; lessons: LessonChoice[] }>();
  for (const l of lessons) {
    const g = groups.get(l.outlineId) ?? {
      label: t("sessions.lessonGroup", {
        name: l.outlineName,
        subject: subjectName.get(l.subjectId) ?? "",
        grade: l.grade,
        whose: l.mine ? "mine" : "programme",
      }),
      lessons: [],
    };
    g.lessons.push(l);
    groups.set(l.outlineId, g);
  }
  return (
    <>
      <div style={fieldGrid}>
        <Field label={t("fields.class")}>
          <select name="linkId" className="text" required defaultValue={d.linkId ?? ""}>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {links.map((l) => (
              <option key={l.linkId} value={l.linkId}>
                {l.subjectName
                  ? t("sessions.classOption", { class: classLabel(t, l.grade, l.section), subject: l.subjectName })
                  : classLabel(t, l.grade, l.section)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("fields.sectionOptional")} hint={t("sessions.sectionHint")}>
          <input name="section" className="text" maxLength={8} defaultValue={d.section ?? ""} autoComplete="off" />
        </Field>
        <Field label={t("fields.subject")}>
          <select name="subjectId" className="text" required defaultValue={d.subjectId ?? ""}>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("fields.lessonOptional")}>
          <select name="lessonId" className="text" defaultValue={d.lessonId ?? ""}>
            <option value="">{t("sessions.noLesson")}</option>
            {[...groups.entries()].map(([id, g]) => (
              <optgroup key={id} label={g.label}>
                {g.lessons.map((l) => (
                  <option key={l.id} value={l.id}>
                    {t("sessions.lessonOption", { n: l.sequence, title: l.title })}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
      </div>
      <div style={fieldGrid}>
        <Field label={t("fields.date")}>
          <input name="date" className="text" type="date" required defaultValue={d.date ?? ""} />
        </Field>
        <Field label={t("fields.timeOptional")}>
          <input name="time" className="text" type="time" defaultValue={d.time?.slice(0, 5) ?? ""} />
        </Field>
        <Field label={t("fields.durationOptional")}>
          <input name="durationMin" className="text" type="number" min={1} max={600} defaultValue={d.durationMin ?? ""} />
        </Field>
        <Field label={t("fields.status")}>
          <select name="status" className="text" defaultValue={d.status ?? "planned"}>
            {SESSION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`sessionStatus.${s}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t("fields.topic")}>
        <input name="topic" className="text" maxLength={240} defaultValue={d.topic ?? ""} autoComplete="off" />
      </Field>
      <Field label={t("fields.notes")} hint={t("sessions.notesHint")}>
        <textarea name="notes" className="text" rows={3} maxLength={4000} defaultValue={d.notes ?? ""} />
      </Field>
    </>
  );
}
