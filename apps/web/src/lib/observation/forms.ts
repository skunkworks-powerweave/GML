// The three stage forms of an observation cycle -- what each one asks, and how
// a submission is read back to the people on the cycle.
//
// WHY THIS EXISTS. The cycle page loaded observation_forms and rendered each
// row as a kind chip and a timestamp; `responses` and `submitted_by_user_id`
// were read by nothing in the app. The observer could not read the teacher's
// lesson plan before observing, the teacher never saw the observer's rubric
// narrative, and the mentor signed off above three chips reading "Submitted".
//
// The same table also carries the spec-077 seed TEMPLATES (submitted_by NULL,
// responses = { description, fields: [...] }), so reading it back has to tell
// a template from a submission, or a nominated cycle reports three forms that
// nobody filled in.
//
// No "server-only" and the database as a parameter (the visibility.ts shape),
// so tests/behaviour can execute it.

import { eq, sql } from "drizzle-orm";
import { observationForms, users } from "@gml/db/schema";
import { validateResponses, type FormField } from "../forms/validate";
import type { Db } from "../visibility";

export type StageKind = "pre" | "observer" | "post";

export type StageField = FormField & { label: string; placeholder: string };

/**
 * What each stage asks. The cycle page renders its inputs from this, and the
 * read-back labels come from it, so a field cannot be added to one without the
 * other.
 */
export const STAGE_FORMS: Record<StageKind, { title: string; fields: StageField[] }> = {
  pre: {
    title: "Pre-observation form",
    fields: [
      {
        name: "lessonPlanSummary",
        kind: "textarea",
        label: "Lesson plan summary",
        required: true,
        placeholder: "What will you teach today?",
      },
    ],
  },
  observer: {
    title: "Observer rubric",
    fields: [
      {
        name: "narrativeComments",
        kind: "textarea",
        label: "Observer rubric notes",
        required: true,
        placeholder: "Rubric narrative…",
      },
    ],
  },
  post: {
    title: "Post-observation reflection",
    fields: [
      {
        name: "whatWorked",
        kind: "textarea",
        label: "What worked / What didn't",
        required: true,
        placeholder: "Reflect on the lesson…",
      },
    ],
  },
};

const STAGE_ORDER: readonly string[] = ["pre", "observer", "post"];

export type StageParse =
  | { ok: true; responses: Record<string, string> }
  | { ok: false; field: string };

/**
 * A stage submission, checked on the SERVER before the cycle advances.
 *
 * The actions used to store every non-`__` key of the posted FormData verbatim
 * and then move the cycle forward -- a transition with no way back. So `{}`,
 * an answer of three spaces, a 10 MB string and arbitrary extra keys were all
 * accepted, each leaving a cycle permanently advanced over an empty record.
 * The textarea's `required` is a browser convenience: whitespace satisfies it
 * and a direct POST never sees it.
 *
 * Only this stage's own questions are kept (an allow-list), trimmed, and put
 * through the same validator the feedback forms use (required, length cap).
 * The first failing question is reported so the page can name it.
 */
export function parseStageResponses(kind: StageKind, formData: FormData): StageParse {
  const fields = STAGE_FORMS[kind].fields;
  const responses: Record<string, string> = {};
  for (const f of fields) {
    const raw = formData.get(f.name);
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) responses[f.name] = value;
  }
  const errors = validateResponses(fields, responses);
  if (errors.length > 0) return { ok: false, field: errors[0]!.field };
  return { ok: true, responses };
}

/** The question a field name belongs to, for an error message. */
export function stageFieldLabel(name: string): string | null {
  return LABELS[name] ?? null;
}

const LABELS: Record<string, string> = Object.fromEntries(
  Object.values(STAGE_FORMS).flatMap((s) => s.fields.map((f) => [f.name, f.label])),
);

export type StoredForm = {
  id: string;
  kind: string;
  responses: Record<string, unknown>;
  submittedAt: Date;
  submittedByUserId: string | null;
  submitterName: string | null;
};

export type SubmittedFormView = {
  id: string;
  kind: string;
  title: string;
  submittedAt: Date;
  submitterName: string | null;
  /** A pre/post form (the teacher's own) submitted by someone else. */
  onBehalf: boolean;
  entries: { label: string; value: string }[];
};

/**
 * A spec-077 template, not a submission: no submitter, and a `fields` array
 * where answers would be. A real submission whose submitter was later removed
 * also has no submitter (ON DELETE SET NULL) but carries answers, so both
 * halves are needed.
 */
export function isTemplateRow(row: { submittedByUserId: string | null; responses: unknown }): boolean {
  const r = row.responses as { fields?: unknown } | null;
  return row.submittedByUserId == null && Array.isArray(r?.fields);
}

function display(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => display(v)).join("\n");
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * The submitted forms of one cycle, in stage order, as label/value pairs.
 *
 * Every party that can open the cycle reads every submitted form: the page is
 * already scoped by assertCanAccessCycle to the teacher, the assigned observer,
 * the actively paired mentor and administrators, and the observer form cannot
 * exist before the cycle reaches 'observed'.
 */
export function submittedFormView(
  rows: readonly StoredForm[],
  opts: { teacherUserId: string | null },
): SubmittedFormView[] {
  return rows
    .filter((r) => !isTemplateRow(r))
    .slice()
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      title: STAGE_FORMS[r.kind as StageKind]?.title ?? r.kind,
      submittedAt: r.submittedAt,
      submitterName: r.submitterName,
      onBehalf:
        (r.kind === "pre" || r.kind === "post") &&
        r.submittedByUserId != null &&
        r.submittedByUserId !== opts.teacherUserId,
      entries: Object.entries(r.responses ?? {})
        // `__`-prefixed keys are form plumbing, never answers.
        .filter(([key]) => !key.startsWith("__"))
        .map(([key, value]) => ({ label: LABELS[key] ?? key, value: display(value) })),
    }));
}

function rank(kind: string): number {
  const i = STAGE_ORDER.indexOf(kind);
  return i === -1 ? STAGE_ORDER.length : i;
}

/** Load and shape a cycle's submitted forms, with each submitter's name. */
export async function loadSubmittedForms(
  db: Db,
  cycleId: string,
  teacherUserId: string | null,
): Promise<SubmittedFormView[]> {
  const rows = await db
    .select({
      id: observationForms.id,
      kind: observationForms.kind,
      responses: observationForms.responses,
      submittedAt: observationForms.submittedAt,
      submittedByUserId: observationForms.submittedByUserId,
      submitterName: sql<string | null>`coalesce(${users.name}, ${users.email})`,
    })
    .from(observationForms)
    .leftJoin(users, eq(users.id, observationForms.submittedByUserId))
    .where(eq(observationForms.cycleId, cycleId));
  return submittedFormView(rows, { teacherUserId });
}
