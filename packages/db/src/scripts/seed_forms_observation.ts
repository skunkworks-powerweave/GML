// Spec 077 — Observation form templates seed (pre / post / observer).
//
// Inserts three canonical templates onto the DEMO seed cycle `OBS-2026-001`
// (which is created by `seed.ts` / spec 086) -- the one whose teacher is a demo
// teacher, never a real cycle that happens to have been minted that code. If
// that cycle is absent -- as it is after purge_demo_data.ts --apply -- this
// warns and returns without inserting anything; it never fails the deploy over
// it. The schema is locked and has no separate `observation_form_templates`
// table, so the templates ride on `observation_forms` rows whose `responses`
// jsonb carries a top-level `fields` array and whose submitter is NULL. No
// application code reads them as templates: the cycle page recognises that
// shape and leaves such rows out (apps/web/src/lib/observation/forms.ts).
//
// Idempotent — uses `(cycle_id, kind)` unique index via
// `.onConflictDoNothing()`. Re-running prints `skipped: 3, inserted: 0`.
//
// Mirrors `seed.ts` for connection setup, dotenv loading, dry-run
// support, and the `main().catch()` error envelope. No new dependencies.

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq, like } from "drizzle-orm";
import { observationCycles, observationForms, teachers } from "../schema/index.js";

const DRY_RUN = process.env.SEED_DRY_RUN === "true";
const CANONICAL_CYCLE_CODE = "OBS-2026-001";

type FieldDef =
  | {
      key: string;
      label: string;
      type: "textarea" | "text";
      required: boolean;
      placeholder?: string;
    }
  | {
      key: string;
      label: string;
      type: "scale";
      required: boolean;
      min: 1;
      max: 5;
      anchors: [string, string, string, string, string];
    };

type Template = {
  kind: "pre" | "post" | "observer";
  description: string;
  fields: FieldDef[];
};

// Spec 140 — canonical kinds accepted by FormRenderer/MobileFormRunner.
// The observation seed uses a per-file vocabulary (text/textarea/scale) that
// the dedicated observation-form renderer maps to canonical kinds at
// render-time. The guard validates that every field type maps to a canonical
// kind; an unmappable type would silently fall through to the text-input
// fallback in any future generic-renderer path (same drift class as the
// singular "checkbox" rename fixes elsewhere in this spec).
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

const OBSERVATION_TYPE_TO_CANONICAL: Record<string, (typeof CANONICAL_FIELD_KINDS)[number]> = {
  text: "text",
  textarea: "textarea",
  scale: "rating",
};

function assertCanonicalFieldKinds(templates: readonly Template[]): readonly Template[] {
  const valid = new Set<string>(CANONICAL_FIELD_KINDS);
  const filtered: Template[] = [];
  for (const t of templates) {
    let allValid = true;
    for (const field of t.fields) {
      const mapped = OBSERVATION_TYPE_TO_CANONICAL[field.type];
      if (!mapped || !valid.has(mapped)) {
        console.warn(
          `[seed:forms:obs] WARN — dropping template (kind=${t.kind}): field "${field.key}" has unmappable type "${field.type}" (canonical set: ${CANONICAL_FIELD_KINDS.join(", ")})`,
        );
        allValid = false;
        break;
      }
    }
    if (allValid) filtered.push(t);
  }
  return filtered;
}

// --- Template definitions -------------------------------------------------

const PRE_TEMPLATE: Template = {
  kind: "pre",
  description: "Teacher self-prep — submitted before the lesson is observed.",
  fields: [
    {
      key: "lessonPlanSummary",
      label: "Lesson plan summary",
      type: "textarea",
      required: true,
      placeholder:
        "Outline the arc of the lesson — opener, main activity, closure.",
    },
    {
      key: "learningOutcomes",
      label: "Learning outcomes targeted (one per line)",
      type: "textarea",
      required: true,
      placeholder:
        "e.g.\nStudents will identify the main idea in a paragraph.\nStudents will draft a 3-sentence summary.",
    },
    {
      key: "anticipatedDifficulties",
      label: "Anticipated student difficulties",
      type: "textarea",
      required: false,
      placeholder:
        "Which steps or concepts do you expect to be hard? How will you scaffold them?",
    },
  ],
};

const POST_TEMPLATE: Template = {
  kind: "post",
  description: "Teacher reflection — submitted after the lesson is observed.",
  fields: [
    {
      key: "whatWorked",
      label: "What worked",
      type: "textarea",
      required: true,
      placeholder: "Which moments landed? What evidence did you see?",
    },
    {
      key: "whatDidNot",
      label: "What did not work",
      type: "textarea",
      required: true,
      placeholder: "Which moments fell flat? What would you change?",
    },
    {
      key: "surpriseMoments",
      label: "Surprise moments",
      type: "textarea",
      required: false,
      placeholder:
        "Unexpected questions, breakthroughs, or detours that taught you something.",
    },
    {
      key: "nextTime",
      label: "Next time",
      type: "textarea",
      required: true,
      placeholder:
        "One concrete change you will make the next time you teach this topic.",
    },
  ],
};

const OBSERVER_TEMPLATE: Template = {
  kind: "observer",
  description: "Observer rubric — completed by the observer during/after the lesson.",
  fields: [
    {
      key: "lessonStructure",
      label: "Lesson structure (1–5)",
      type: "scale",
      required: true,
      min: 1,
      max: 5,
      anchors: [
        "No discernible structure",
        "Opener or closure present but disconnected",
        "Clear arc, transitions abrupt",
        "Clear arc, transitions smooth",
        "Crisp arc with deliberate transitions and a memorable closure",
      ],
    },
    {
      key: "studentEngagement",
      label: "Student engagement (1–5)",
      type: "scale",
      required: true,
      min: 1,
      max: 5,
      anchors: [
        "Few students participate",
        "A handful of students dominate",
        "Most students engaged at least once",
        "Broad participation across the class",
        "Sustained, distributed engagement with peer-to-peer talk",
      ],
    },
    {
      key: "teacherQuestioning",
      label: "Teacher questioning quality (1–5)",
      type: "scale",
      required: true,
      min: 1,
      max: 5,
      anchors: [
        "Mostly closed / yes-no questions",
        "Some open questions but no follow-up",
        "Open questions with occasional follow-up",
        "Open questions with consistent probing",
        "Layered questioning that surfaces student reasoning",
      ],
    },
    {
      key: "classroomManagement",
      label: "Classroom management (1–5)",
      type: "scale",
      required: true,
      min: 1,
      max: 5,
      anchors: [
        "Frequent disruptions, time lost",
        "Some disruptions, partial recovery",
        "Most routines work; a few hiccups",
        "Routines are smooth and visible",
        "Invisible management — routines run themselves",
      ],
    },
    {
      key: "languageUse",
      label: "Language use (1–5)",
      type: "scale",
      required: true,
      min: 1,
      max: 5,
      anchors: [
        "Frequent inaccuracies in target language",
        "Mostly accurate, often code-mixes",
        "Accurate, code-mixes when scaffolding",
        "Accurate and deliberate code-switching",
        "Models the target language with precision and warmth",
      ],
    },
    {
      key: "narrativeComments",
      label: "Narrative comments",
      type: "textarea",
      required: true,
      placeholder:
        "What stood out? What is one specific, actionable suggestion for the teacher?",
    },
  ],
};

const TEMPLATES: readonly Template[] = assertCanonicalFieldKinds([
  PRE_TEMPLATE,
  POST_TEMPLATE,
  OBSERVER_TEMPLATE,
]);

// --- The two steps, on a caller's handle ------------------------------------
//
// Taking the database as a parameter is what lets tests/behaviour run these
// inside a transaction it rolls back; main() below binds them to a pool.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = NodePgDatabase<any>;

// The demo teachers seed.ts writes carry +91 9419100001.. -- the same
// recogniser purge_demo_data.ts uses (DEMO_TEACHER_PHONE_PREFIX there).
const DEMO_TEACHER_PHONE_PREFIX = "+91 94191000";

/**
 * The cycle the templates hang on, or null when there is none to use.
 *
 * THE DEMO CYCLE, NOT "WHATEVER IS CALLED OBS-2026-001". The lookup used to be
 * the code alone. After the day-one purge removes OBS-2026-001..008,
 * nextCycleCode() mints max+1 over the codes that remain, so the first REAL
 * nomination is OBS-2026-001 again -- and the next deploy hung three fake
 * "submitted" forms on a real teacher's cycle, re-filling on every later
 * deploy whichever kinds she had not yet submitted. A code is reused; a demo
 * teacher's phone number is not.
 */
export async function findTemplateAnchor(db: AnyDb): Promise<{ id: string } | null> {
  const cycleRows = await db
    .select({ id: observationCycles.id })
    .from(observationCycles)
    .innerJoin(teachers, eq(teachers.id, observationCycles.teacherId))
    .where(
      and(
        eq(observationCycles.code, CANONICAL_CYCLE_CODE),
        like(teachers.phone, `${DEMO_TEACHER_PHONE_PREFIX}%`),
      ),
    )
    .limit(1);
  return cycleRows[0] ?? null;
}

/** Attach the templates to `cycleId`; a kind already present is left alone. */
export async function insertTemplates(db: AnyDb, cycleId: string): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const t of TEMPLATES) {
    const result = await db
      .insert(observationForms)
      .values({
        cycleId,
        kind: t.kind,
        schemaVersion: "1",
        responses: {
          description: t.description,
          fields: t.fields,
        },
        submittedAt: new Date(),
        submittedByUserId: null,
      })
      .onConflictDoNothing({
        target: [observationForms.cycleId, observationForms.kind],
      })
      .returning({ id: observationForms.id });
    if (result.length > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }
  return { inserted, skipped };
}

// --- Main -----------------------------------------------------------------

export async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[seed:forms:obs] DATABASE_URL not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    console.log(
      `[seed:forms:obs] looking up canonical cycle code=${CANONICAL_CYCLE_CODE}…`,
    );
    const canonical = await findTemplateAnchor(db);
    if (!canonical) {
      // A WARNING AND A RETURN, NOT process.exit(1).
      //
      // The anchor is absent in exactly two situations, and neither is a
      // failure of this deploy:
      //
      //   * purge_demo_data.ts --apply ran (README-deploy.md 3.1, the day-one
      //     step). OBS-2026-001 is demo data, the templates on it have no
      //     submitter so they never count as "real work", and it is removed
      //     with the other demo cycles. seed.ts will never recreate it -- it
      //     skips everything once any district exists, and the purge keeps the
      //     districts on purpose.
      //   * seed.ts has not run yet, which seed_all.ts rules out by ordering.
      //
      // (A REAL cycle that was later minted OBS-2026-001 is not the anchor
      // either -- see findTemplateAnchor -- and lands here too.)
      //
      // This used to exit 1. deploy.sh runs seed_all.ts under `set -euo
      // pipefail` on every deploy, and a process.exit() inside a phase kills
      // the orchestrator outright, so every deploy after the documented purge
      // stopped at the seed step -- after the containers were already up and
      // healthy, and before verify-auth and the smoke check could run. Nothing
      // in the application reads these three template rows, so skipping them
      // costs nothing a user can see.
      console.warn(
        `[seed:forms:obs] canonical demo cycle '${CANONICAL_CYCLE_CODE}' not found — skipping the ${TEMPLATES.length} observation templates. ` +
          `Expected after purge_demo_data.ts --apply, which removes the demo cycles. ` +
          `On a fresh database, run seed first (\`pnpm --filter @gml/db run seed\`).`,
      );
      await pool.end();
      return;
    }

    if (DRY_RUN) {
      console.log(
        `[seed:forms:obs] DRY_RUN — would insert ${TEMPLATES.length} templates (pre/post/observer) onto cycle ${canonical.id}`,
      );
      for (const t of TEMPLATES) {
        console.log(
          `[seed:forms:obs]   kind=${t.kind} fields=${t.fields.length}`,
        );
      }
      await pool.end();
      return;
    }

    const { inserted, skipped } = await insertTemplates(db, canonical.id);

    console.log(
      `[seed:forms:obs] done — inserted: ${inserted}, skipped: ${skipped}, total: ${TEMPLATES.length}`,
    );
    await pool.end();
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

// Auto-run only when invoked directly (e.g. `tsx seed_forms_observation.ts`), not
// when imported by the seed_all.ts orchestrator (spec 104).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[seed:forms:obs] failed:", err);
    process.exit(1);
  });
}
