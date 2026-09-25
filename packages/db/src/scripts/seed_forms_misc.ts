// Spec 078 — Seed two miscellaneous feedback forms:
//   1. School-visit checklist (mentor-facing field-visit form)
//   2. Endline survey (mentee-facing programme-close reflection)
//
// Idempotent. Uses the natural key `(kind, audience, version)` which already has
// a unique index on the table (`feedback_forms_kind_audience_version_uq`).
//
// Schema is locked — `feedbackKindEnum` lacks `schoolvisit`/`endline` values,
// so we ride the existing enum values (`baseline`/`final`) and disambiguate via
// the `version` column's natural suffix ("schoolvisit-1", "endline-1") plus a
// stable `purpose` discriminator embedded inside the JSON `schema` payload that
// the renderer (spec 080) keys off of.
//
// Run via:  DATABASE_URL=postgres://… pnpm --filter @gml/db exec tsx src/scripts/seed_forms_misc.ts
// Dry run:  SEED_DRY_RUN=true pnpm --filter @gml/db exec tsx src/scripts/seed_forms_misc.ts

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { feedbackForms, feedbackResponses } from "../schema/mentorship.js";
import { repairDecision } from "./seed_forms_misc_repair.js";
import { FORM_FIELD_KINDS, OPTION_BEARING_FIELD_KINDS } from "../formFieldKinds.js";

const DRY_RUN = process.env.SEED_DRY_RUN === "true";

// ---------------------------------------------------------------------------
// Form schema definitions — shape consumed by the renderer in spec 080.
// `purpose` is the renderer's dispatch key (route-around for the missing enum
// value); `fields[]` carries field id, kind, label, optional Hindi gloss, and
// per-kind metadata (options for choice/boolean-group, min/max for rating).
// ---------------------------------------------------------------------------

type FieldKind = "boolean" | "boolean-group" | "rating" | "textarea" | "single-choice" | "text";

// Spec 140 — canonical kinds accepted by FormRenderer/MobileFormRunner.
// The misc seed uses a per-file vocabulary (boolean / single-choice etc.) that
// the dedicated misc-form renderer (spec 080) maps to canonical kinds at
// render-time. The guard validates that every field kind maps to a canonical
// kind; an unmappable kind would silently fall through to the text-input
// fallback in any future generic-renderer path (same drift class as the
// singular "checkbox" rename fixes elsewhere in this spec).
//
// The same list PUT /api/admin/forms/[id] validates against (formFieldKinds.ts):
// an edit the route accepts is never one this seed treats as broken.
const CANONICAL_FIELD_KINDS = FORM_FIELD_KINDS;

// Kinds whose renderer draws one control PER OPTION. A field of one of these
// kinds with no options renders as literally nothing.
const OPTION_BEARING_KINDS: ReadonlySet<string> = OPTION_BEARING_FIELD_KINDS;

const MISC_KIND_TO_CANONICAL: Record<FieldKind, (typeof CANONICAL_FIELD_KINDS)[number]> = {
  // A SINGLE yes/no is a radio pair, not a checkbox.
  //
  // It used to map to "checkbox" alongside "boolean-group", and that was wrong
  // in a way no type could catch: the two kinds have different SHAPES. A
  // boolean-group carries its own options; a plain boolean carries none. The
  // checkbox renderer draws one box per option, and `normalizeOptions(undefined)`
  // is `[]`, so `morning_routine_observed` and `library_accessible` rendered as
  // an empty gap -- no control, no label, nothing to click. Both are
  // `required: true`, so the school-visit checklist could never be submitted by
  // anyone. Two of its nine questions were invisible and it was permanently
  // stuck at "please complete the required fields".
  //
  // Yes/No as a radio gives a visible, answerable control; the stored value
  // stays the literal "Yes"/"No" string, which is what validate.ts checks
  // against the options list.
  boolean: "radio",
  "boolean-group": "checkbox",
  rating: "rating",
  textarea: "textarea",
  "single-choice": "radio",
  text: "text",
};

/** The options a mapped field must end up with, when its source kind supplies none. */
const SYNTHESISED_OPTIONS: Partial<Record<FieldKind, string[]>> = {
  boolean: ["Yes", "No"],
};

/**
 * Rewrite this file's field vocabulary into the CANONICAL shape the renderers
 * and lib/forms/validate.ts read: `{name, kind}`, with kinds drawn from
 * CANONICAL_FIELD_KINDS.
 *
 * The previous version of this function CHECKED that every kind could be
 * mapped and then returned the rows UNCHANGED -- it computed `mapped` and threw
 * it away. Identical defect to the one in seed_forms_mentee.ts, and with the
 * same total consequence: these forms reached the database keyed `{id, kind}`
 * with kinds like "boolean-group" and "single-choice" that no renderer knows,
 * so every field fell through to the text fallback, and because `name` was
 * undefined they all shared one FormData key -- a whole school-visit
 * questionnaire collapsed into a single unnamed textbox.
 *
 * The guard written to prevent exactly this was what concealed it: it validated
 * the mapping instead of applying it, and then reported success.
 */
function toCanonicalFields(rows: SeedRow[]): CanonicalSeedRow[] {
  const valid = new Set<string>(CANONICAL_FIELD_KINDS);
  const out: CanonicalSeedRow[] = [];

  for (const row of rows) {
    const mappedFields: CanonicalField[] = [];
    let allValid = true;

    for (const field of row.schema.fields) {
      const kind = (MISC_KIND_TO_CANONICAL as Record<string, (typeof CANONICAL_FIELD_KINDS)[number] | undefined>)[field.kind];
      if (!kind || !valid.has(kind)) {
        console.warn(
          `[seed-forms-misc] WARN - dropping row (label=${row.label}): field "${field.id}" has unmappable kind "${field.kind}" (canonical set: ${CANONICAL_FIELD_KINDS.join(", ")})`,
        );
        allValid = false;
        break;
      }
      const options = field.options ?? SYNTHESISED_OPTIONS[field.kind];

      // The check the ORIGINAL guard should have been: not "does this kind map"
      // but "is the mapped field renderable". An option-bearing kind with no
      // options draws zero controls, and if it is also required the whole form
      // becomes unsubmittable -- silently, because nothing is on screen to
      // point at. Refuse the row rather than seed a dead form.
      if (OPTION_BEARING_KINDS.has(kind) && (!options || options.length === 0)) {
        console.warn(
          `[seed-forms-misc] WARN - dropping row (label=${row.label}): field "${field.id}" maps to "${kind}", which renders one control per option, but has none. It would render as an empty gap.`,
        );
        allValid = false;
        break;
      }

      mappedFields.push({
        name: field.id,
        kind,
        label: field.label,
        hindiLabel: field.hindiLabel,
        required: field.required,
        options,
        min: field.min,
        max: field.max,
        helpText: field.helpText,
      });
    }

    if (allValid) out.push({ ...row, schema: { ...row.schema, fields: mappedFields } });
  }

  return out;
}

/** The canonical field shape, as FormRenderer and validate.ts read it. */
interface CanonicalField {
  name: string;
  kind: (typeof CANONICAL_FIELD_KINDS)[number];
  label: string;
  hindiLabel?: string;
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  helpText?: string;
}

/** A seed row after mapping: identical metadata, canonical fields. */
type CanonicalSeedRow = Omit<SeedRow, "schema"> & {
  schema: Omit<FormSchema, "fields"> & { fields: CanonicalField[] };
};

interface FormField {
  id: string;
  kind: FieldKind;
  label: string;
  hindiLabel?: string;
  required?: boolean;
  options?: string[]; // for single-choice + boolean-group
  min?: number; // for rating
  max?: number; // for rating
  helpText?: string;
}

interface FormSchema {
  purpose: "schoolvisit" | "endline";
  title: string;
  hindiTitle?: string;
  description?: string;
  fields: FormField[];
}

const SCHOOLVISIT_SCHEMA: FormSchema = {
  purpose: "schoolvisit",
  title: "School visit checklist",
  hindiTitle: "स्कूल भ्रमण चेकलिस्ट",
  description: "Field-visit form for mentors and observers. Records on-the-ground observations during a campus walkthrough.",
  fields: [
    {
      id: "infra_observations",
      kind: "boolean-group",
      label: "Infrastructure observations",
      hindiLabel: "बुनियादी ढाँचा अवलोकन",
      required: true,
      options: [
        "Toilets functional",
        "Drinking water available",
        "Furniture intact",
        "Blackboard usable",
        "Library room exists",
      ],
    },
    {
      id: "morning_routine_observed",
      kind: "boolean",
      label: "Morning assembly / routine observed?",
      hindiLabel: "प्रातःकालीन सभा देखी गयी?",
      required: true,
    },
    {
      id: "library_accessible",
      kind: "boolean",
      label: "Library accessible to students today?",
      hindiLabel: "क्या पुस्तकालय आज छात्रों के लिए उपलब्ध है?",
      required: true,
    },
    {
      id: "teacher_attendance_pattern",
      kind: "single-choice",
      label: "Teacher attendance pattern (this month)",
      hindiLabel: "इस महीने शिक्षक उपस्थिति पैटर्न",
      required: true,
      options: ["Regular daily", "Mostly regular", "Irregular", "Frequently absent"],
    },
    {
      id: "classroom_hygiene_rating",
      kind: "rating",
      label: "Classroom hygiene rating",
      hindiLabel: "कक्षा स्वच्छता रेटिंग",
      required: true,
      min: 1,
      max: 5,
      helpText: "1 = poor · 5 = excellent",
    },
    {
      id: "notes",
      kind: "textarea",
      label: "Additional notes",
      hindiLabel: "अतिरिक्त टिप्पणियाँ",
      required: false,
    },
  ],
};

const ENDLINE_SCHEMA: FormSchema = {
  purpose: "endline",
  title: "Endline survey",
  hindiTitle: "कार्यक्रम समापन सर्वेक्षण",
  description: "Programme-close reflection completed by mentees who have finished the full RTT cohort.",
  fields: [
    {
      id: "years_in_programme_reflection",
      kind: "textarea",
      label: "What did the programme do for you across the years?",
      hindiLabel: "कार्यक्रम ने इन वर्षों में आपके लिए क्या किया?",
      required: true,
      helpText: "Free-form reflection. Reference specific phases or terms if helpful.",
    },
    {
      id: "top_three_learnings",
      kind: "textarea",
      label: "Top three learnings",
      hindiLabel: "तीन प्रमुख सीखें",
      required: true,
      helpText: "List up to three learnings, one per line.",
    },
    {
      id: "would_mentor_next_cohort",
      kind: "single-choice",
      label: "Would you mentor the next cohort?",
      hindiLabel: "क्या आप अगले समूह को सलाह देना चाहेंगे?",
      required: true,
      options: ["Yes", "No"],
    },
    {
      id: "improvement_suggestions",
      kind: "textarea",
      label: "Open suggestions for improvement",
      hindiLabel: "सुधार के लिए सुझाव",
      required: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Row definitions. We hold the natural-key triple (kind, audience, version)
// outside the row so the existence check can run before we attempt an insert.
// ---------------------------------------------------------------------------

interface SeedRow {
  label: string; // for logging
  kind: "baseline" | "progress_1" | "progress_2" | "final";
  audience: "mentor" | "mentee";
  version: string;
  schema: FormSchema;
}

const ROWS: CanonicalSeedRow[] = toCanonicalFields([
  {
    label: "school-visit checklist",
    kind: "baseline", // route-around: closest existing enum value
    audience: "mentor", // mentor-facing field visit
    version: "schoolvisit-1",
    schema: SCHOOLVISIT_SCHEMA,
  },
  {
    label: "endline survey",
    kind: "final", // programme-close
    audience: "mentee", // mentee-facing
    version: "endline-1",
    schema: ENDLINE_SCHEMA,
  },
]);

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[seed-forms-misc] DATABASE_URL not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  let inserted = 0;
  let skipped = 0;
  let repaired = 0;

  try {
    console.log(`[seed-forms-misc] starting${DRY_RUN ? " (DRY_RUN)" : ""}…`);

    for (const row of ROWS) {
      const existing = await db
        .select({ id: feedbackForms.id })
        .from(feedbackForms)
        .where(
          and(
            eq(feedbackForms.kind, row.kind),
            eq(feedbackForms.audience, row.audience),
            eq(feedbackForms.version, row.version),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        // REPAIR-ON-DRIFT.
        //
        // A plain skip is right for a form an administrator may have edited,
        // and wrong for one this script seeded WRONG. The school-visit
        // checklist shipped with two required fields mapped to a kind that
        // renders one control per option and had no options, so they drew
        // nothing at all and the form could not be submitted by anyone. Fixing
        // the mapping above does not help a row that is already in the
        // database, and nobody can repair a field they cannot see.
        //
        // So: if the stored schema is one NO RENDERER CAN DRAW -- the shapes
        // this file once shipped -- and NOBODY HAS ANSWERED THE FORM, rewrite
        // it. A schema that merely differs from today's seed is an
        // administrator's edit (/admin/forms/[id]) and is kept: this used to
        // rewrite any difference, so a customisation made before the first
        // response vanished at the next deploy. The no-responses guard stays,
        // because replacing a form in use would orphan the answers already
        // keyed against its field names. seed_forms_misc_repair.ts decides.
        const id = existing[0].id;
        const [{ stored } = { stored: null }] = await db
          .select({ stored: feedbackForms.schema })
          .from(feedbackForms)
          .where(eq(feedbackForms.id, id))
          .limit(1);

        const [{ answers } = { answers: 0 }] = await db
          .select({ answers: sql<number>`count(*)::int` })
          .from(feedbackResponses)
          .where(eq(feedbackResponses.formId, id));

        // Compared ignoring key order: jsonb does not keep the literal's, so
        // a plain JSON.stringify comparison never matched and both rows were
        // rewritten on every run.
        const decision = repairDecision(stored, row.schema, answers, {
          kinds: CANONICAL_FIELD_KINDS,
          optionBearing: OPTION_BEARING_KINDS,
        });

        if (decision === "current") {
          console.log(
            `[seed-forms-misc] SKIP  ${row.label} — already present and current (id=${id}, version=${row.version})`,
          );
          skipped++;
          continue;
        }

        if (decision === "edited") {
          console.log(
            `[seed-forms-misc] KEEP  ${row.label} — differs from this seed but is a valid form: treated as an administrator's edit (id=${id}).`,
          );
          skipped++;
          continue;
        }

        if (decision === "answered") {
          console.warn(
            `[seed-forms-misc] KEEP  ${row.label} — stored schema differs from this seed, but ${answers} response(s) exist (id=${id}). Left untouched; migrate it by hand or publish a new version.`,
          );
          skipped++;
          continue;
        }

        if (DRY_RUN) {
          console.log(`[seed-forms-misc] WOULD REPAIR  ${row.label} (id=${id}) — schema drifted, 0 responses`);
          repaired++;
          continue;
        }

        await db
          .update(feedbackForms)
          .set({ schema: row.schema })
          .where(eq(feedbackForms.id, id));
        console.log(
          `[seed-forms-misc] REPAIR  ${row.label} — stored schema replaced (id=${id}, 0 responses)`,
        );
        repaired++;
        continue;
      }

      if (DRY_RUN) {
        console.log(
          `[seed-forms-misc] WOULD INSERT  ${row.label} (kind=${row.kind}, audience=${row.audience}, version=${row.version})`,
        );
        inserted++;
        continue;
      }

      const result = await db
        .insert(feedbackForms)
        .values({
          kind: row.kind,
          audience: row.audience,
          version: row.version,
          active: true,
          schema: row.schema,
        })
        .returning({ id: feedbackForms.id, version: feedbackForms.version });

      const created = result[0];
      console.log(
        `[seed-forms-misc] INSERT  ${row.label} (id=${created.id}, version=${created.version})`,
      );
      inserted++;
    }

    console.log(
      `[seed-forms-misc] DONE — inserted=${inserted}, repaired=${repaired}, skipped=${skipped}${DRY_RUN ? " (dry-run; no writes)" : ""}.`,
    );
  } catch (err) {
    console.error("[seed-forms-misc] failed:", err);
    await pool.end();
    process.exit(1);
  }

  await pool.end();
}

// Auto-run only when invoked directly (e.g. `tsx seed_forms_misc.ts`), not
// when imported by the seed_all.ts orchestrator (spec 104).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[seed-forms-misc] unhandled:", err);
    process.exit(1);
  });
}
