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
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { feedbackForms } from "../schema/mentorship.js";

const DRY_RUN = process.env.SEED_DRY_RUN === "true";

// ---------------------------------------------------------------------------
// Form schema definitions — shape consumed by the renderer in spec 080.
// `purpose` is the renderer's dispatch key (route-around for the missing enum
// value); `fields[]` carries field id, kind, label, optional Hindi gloss, and
// per-kind metadata (options for choice/boolean-group, min/max for rating).
// ---------------------------------------------------------------------------

type FieldKind = "boolean" | "boolean-group" | "rating" | "textarea" | "single-choice" | "text";

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

const ROWS: SeedRow[] = [
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
];

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
        console.log(
          `[seed-forms-misc] SKIP  ${row.label} — already present (id=${existing[0].id}, version=${row.version})`,
        );
        skipped++;
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
      `[seed-forms-misc] DONE — inserted=${inserted}, skipped=${skipped}${DRY_RUN ? " (dry-run; no writes)" : ""}.`,
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
