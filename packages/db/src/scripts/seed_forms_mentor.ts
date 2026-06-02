// Spec 075 — Mentor-audience feedback-form seed.
// Inserts 4 rows into feedback_forms (baseline / progress_1 / progress_2 / final) for the
// MENTOR audience. Idempotent: each row is gated on the existing
// (kind, audience, version) unique index from spec 020 before insert.
//
// Run:  tsx packages/db/src/scripts/seed_forms_mentor.ts
// Dry:  SEED_DRY_RUN=true tsx packages/db/src/scripts/seed_forms_mentor.ts

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { feedbackForms } from "../schema/mentorship.js";

const DRY_RUN = process.env.SEED_DRY_RUN === "true" || process.env.DRY_RUN === "true";

type FieldKind =
  | "text"
  | "textarea"
  | "checkbox"
  | "radio"
  | "select"
  | "rating"
  | "number"
  | "date";

// Spec 140 — canonical kinds accepted by FormRenderer/MobileFormRunner.
// Any field.kind outside this set falls through to the text-input fallback
// in the renderer, which silently broke the previous plural form here.
// Validation runs at module load (see assertCanonicalFieldKinds below).
const CANONICAL_FIELD_KINDS = [
  "text",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "number",
  "date",
  "likert",
  "rating",
] as const;
type CanonicalFieldKind = (typeof CANONICAL_FIELD_KINDS)[number];

function assertCanonicalFieldKinds(forms: { kind: string; audience: string; version: string; schema: { fields: { kind: string; name: string }[] } }[]): typeof forms {
  const valid = new Set<string>(CANONICAL_FIELD_KINDS);
  const filtered: typeof forms = [];
  for (const form of forms) {
    let allValid = true;
    for (const field of form.schema.fields) {
      if (!valid.has(field.kind)) {
        console.warn(
          `[seed-forms-mentor] WARN — dropping form (kind=${form.kind}, audience=${form.audience}, version=${form.version}): field "${field.name}" has invalid kind "${field.kind}" (not in canonical renderer set ${CANONICAL_FIELD_KINDS.join(", ")})`,
        );
        allValid = false;
        break;
      }
    }
    if (allValid) filtered.push(form);
  }
  return filtered;
}

interface FormField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
  helpText?: string;
}

interface FormSchema {
  fields: FormField[];
}

type FeedbackKind = "baseline" | "progress_1" | "progress_2" | "final";
type FeedbackAudience = "mentor" | "mentee";

interface SeedForm {
  kind: FeedbackKind;
  audience: FeedbackAudience;
  version: string;
  schema: FormSchema;
}

// ---------------------------------------------------------------------------
// Form catalogues — MENTOR audience.
// Field `name` keys are stable snake_case identifiers so feedback_responses
// JSON stays valid across template versions (mentee Q2 cycle continues to
// reference these keys via the renderer in spec 077/078).
// ---------------------------------------------------------------------------

const MENTOR_BASELINE: SeedForm = {
  kind: "baseline",
  audience: "mentor",
  version: "1",
  schema: {
    fields: [
      {
        name: "bio",
        label: "Mentor bio for this pairing",
        kind: "textarea",
        required: true,
        helpText: "2–3 sentences on your background relevant to the teacher you are pairing with.",
      },
      {
        name: "expertise_areas",
        label: "Expertise areas you bring to this pairing",
        kind: "checkbox",
        required: true,
        options: [
          "Reading comprehension",
          "Phonics",
          "CPA in mathematics",
          "Activity-based EVS",
          "Classroom management",
          "Formative assessment",
          "Lesson planning",
          "Bilingual instruction",
        ],
      },
      {
        name: "expected_goals",
        label: "Expected goals for this teacher across the cycle",
        kind: "textarea",
        required: true,
        helpText: "Concrete, observable goals — what does success look like by the final review?",
      },
      {
        name: "preferred_meeting_style",
        label: "Preferred meeting style",
        kind: "radio",
        required: true,
        options: ["Video call", "Voice call", "In-person visit"],
      },
      {
        name: "meeting_cadence",
        label: "Proposed meeting cadence",
        kind: "select",
        required: true,
        options: ["Weekly", "Fortnightly", "Monthly"],
      },
      {
        name: "starting_focus_subject",
        label: "Starting focus subject",
        kind: "select",
        required: false,
        options: ["English", "Math", "EVS", "Hindi", "Urdu", "Science", "Social Studies"],
      },
      {
        name: "anticipated_constraints",
        label: "Anticipated constraints (connectivity, school timing, travel)",
        kind: "textarea",
        required: false,
        helpText: "Optional — flag any structural barriers you foresee.",
      },
    ],
  },
};

const MENTOR_PROGRESS_Q1: SeedForm = {
  kind: "progress_1",
  audience: "mentor",
  version: "1",
  schema: {
    fields: [
      {
        name: "mentee_progress_rating",
        label: "Mentee progress against Q1 goals",
        kind: "rating",
        required: true,
        options: ["1 — No movement", "2", "3 — On track", "4", "5 — Exceeding"],
      },
      {
        name: "engagement_rating",
        label: "Engagement and openness to feedback (Q1)",
        kind: "rating",
        required: true,
        options: ["1", "2", "3", "4", "5"],
      },
      {
        name: "narrative_reflection",
        label: "Narrative reflection on Q1",
        kind: "textarea",
        required: true,
        helpText: "What changed in the teacher's practice this quarter? Evidence-led.",
      },
      {
        name: "wins_observed",
        label: "Specific wins observed this quarter",
        kind: "textarea",
        required: false,
      },
      {
        name: "concerns",
        label: "Concerns or risks to flag",
        kind: "textarea",
        required: false,
        helpText: "Leave blank if none.",
      },
      {
        name: "meetings_held",
        label: "Meetings held this quarter",
        kind: "number",
        required: true,
      },
      {
        name: "next_quarter_focus",
        label: "Focus area for Q2",
        kind: "textarea",
        required: true,
      },
    ],
  },
};

const MENTOR_PROGRESS_Q2: SeedForm = {
  kind: "progress_2",
  audience: "mentor",
  version: "2",
  schema: {
    fields: [
      {
        name: "mentee_progress_rating",
        label: "Mentee progress against Q2 goals",
        kind: "rating",
        required: true,
        options: ["1 — No movement", "2", "3 — On track", "4", "5 — Exceeding"],
      },
      {
        name: "engagement_rating",
        label: "Engagement and openness to feedback (Q2)",
        kind: "rating",
        required: true,
        options: ["1", "2", "3", "4", "5"],
      },
      {
        name: "classroom_practice_rating",
        label: "Classroom practice quality (Q2)",
        kind: "rating",
        required: true,
        options: ["1", "2", "3", "4", "5"],
        helpText: "Composite of planning, delivery and assessment evidence.",
      },
      {
        name: "narrative_reflection",
        label: "Narrative reflection on Q2",
        kind: "textarea",
        required: true,
        helpText: "How has the teacher's practice evolved since Q1? Be specific.",
      },
      {
        name: "wins_observed",
        label: "Specific wins observed this quarter",
        kind: "textarea",
        required: false,
      },
      {
        name: "concerns",
        label: "Concerns or risks to flag",
        kind: "textarea",
        required: false,
        helpText: "Leave blank if none.",
      },
      {
        name: "course_correction_needed",
        label: "Course correction needed before Q3?",
        kind: "radio",
        required: true,
        options: ["No — staying the course", "Yes — minor adjustment", "Yes — significant re-plan"],
      },
      {
        name: "meetings_held",
        label: "Meetings held this quarter",
        kind: "number",
        required: true,
      },
      {
        name: "next_quarter_focus",
        label: "Focus area for Q3",
        kind: "textarea",
        required: true,
      },
    ],
  },
};

const MENTOR_FINAL: SeedForm = {
  kind: "final",
  audience: "mentor",
  version: "1",
  schema: {
    fields: [
      {
        name: "holistic_rating",
        label: "Holistic rating of the mentee across the full cycle",
        kind: "rating",
        required: true,
        options: ["1 — No growth", "2", "3 — Solid growth", "4", "5 — Transformative"],
      },
      {
        name: "recommendation",
        label: "Recommendation",
        kind: "radio",
        required: true,
        options: [
          "Promote to phase lead",
          "Advance to next phase",
          "Repeat current phase",
          "Withdraw from programme",
        ],
      },
      {
        name: "achievements",
        label: "Key achievements across the cycle",
        kind: "textarea",
        required: true,
        helpText: "List 2–4 concrete wins with evidence (video timestamps, observation notes).",
      },
      {
        name: "growth_areas",
        label: "Growth areas going forward",
        kind: "textarea",
        required: true,
      },
      {
        name: "would_pair_again",
        label: "Would you pair with this teacher again?",
        kind: "radio",
        required: true,
        options: ["Yes", "No", "Unsure"],
      },
      {
        name: "programme_feedback",
        label: "Feedback on the mentorship programme itself",
        kind: "textarea",
        required: false,
        helpText: "Optional — what would help future cycles run better?",
      },
      {
        name: "cycle_completed_on",
        label: "Cycle completion date",
        kind: "date",
        required: true,
      },
    ],
  },
};

const FORMS: SeedForm[] = assertCanonicalFieldKinds([
  MENTOR_BASELINE,
  MENTOR_PROGRESS_Q1,
  MENTOR_PROGRESS_Q2,
  MENTOR_FINAL,
]) as SeedForm[];

export async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[seed-forms-mentor] DATABASE_URL not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  console.log(`[seed-forms-mentor] starting (DRY_RUN=${DRY_RUN}) — ${FORMS.length} mentor forms to consider`);

  let inserted = 0;
  let skipped = 0;

  try {
    for (const form of FORMS) {
      const existing = await db
        .select({ id: feedbackForms.id })
        .from(feedbackForms)
        .where(
          and(
            eq(feedbackForms.kind, form.kind),
            eq(feedbackForms.audience, form.audience),
            eq(feedbackForms.version, form.version),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        skipped += 1;
        console.log(
          `[seed-forms-mentor] skipping (kind=${form.kind}, audience=${form.audience}, version=${form.version}) — already present`,
        );
        continue;
      }

      if (DRY_RUN) {
        inserted += 1;
        console.log(
          `[seed-forms-mentor] DRY_RUN would insert (kind=${form.kind}, audience=${form.audience}, version=${form.version}) — ${form.schema.fields.length} fields`,
        );
        continue;
      }

      await db.insert(feedbackForms).values({
        kind: form.kind,
        audience: form.audience,
        version: form.version,
        schema: form.schema,
        active: true,
      });
      inserted += 1;
      console.log(
        `[seed-forms-mentor] inserted (kind=${form.kind}, audience=${form.audience}, version=${form.version}) — ${form.schema.fields.length} fields`,
      );
    }

    console.log(
      `[seed-forms-mentor] DONE: inserted ${inserted}, skipped ${skipped} (${FORMS.length} mentor forms)`,
    );
  } catch (err) {
    console.error("[seed-forms-mentor] failed:", err);
    await pool.end();
    process.exit(1);
  }

  await pool.end();
}

// Auto-run only when invoked directly (e.g. `tsx seed_forms_mentor.ts`), not
// when imported by the seed_all.ts orchestrator (spec 104).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[seed-forms-mentor] failed:", err);
    process.exit(1);
  });
}
