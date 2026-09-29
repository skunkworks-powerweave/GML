// Seed the default grading scales and the default observation rubric.
//
//   student       "CBSE 8-point": A1 91-100 ... D 33-40, E 0-32 (fail)
//   quiz          "Quiz grades": Excellent 90-100 ... Needs work 0-59 (fail)
//   observation   "Observation levels": Exemplary 85-100 ... Beginning 0-49
//   rubric        "Classroom observation rubric": six criteria, each out of 4,
//                 graded on the observation scale
//
// Idempotent BY NAME: a scale or rubric that already exists is left exactly
// as it is -- an administrator may have edited its bands or criteria at
// /admin/grading, and a deploy must not undo that. A new one becomes the
// default for what it grades only when nothing is the default yet, so a
// default an administrator chose is never taken away. seed_all.ts runs this
// on every deploy.
//
// The names and descriptions are data an administrator loads and edits, so
// they are stored in English as written here, like the rest of the seed.
//
// Run:  DATABASE_URL=postgres://… pnpm --filter @gml/db exec tsx src/scripts/seed_grading.ts
// Dry:  SEED_DRY_RUN=true pnpm --filter @gml/db exec tsx src/scripts/seed_grading.ts

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { gradingBands, gradingScales, type GradingTarget } from "../schema/grading.js";
import { observationRubrics, rubricCriteria } from "../schema/observation.js";
import { poolConfig } from "../client.js";

type SeedBand = { label: string; minPct: number; maxPct: number; isPass: boolean };
type SeedScale = { name: string; appliesTo: GradingTarget; description: string; bands: SeedBand[] };

export const DEFAULT_SCALES: readonly SeedScale[] = [
  {
    name: "CBSE 8-point",
    appliesTo: "student",
    description: "The CBSE eight-point grade scale for students' test marks. E (below 33%) is a fail.",
    bands: [
      { label: "A1", minPct: 91, maxPct: 100, isPass: true },
      { label: "A2", minPct: 81, maxPct: 90, isPass: true },
      { label: "B1", minPct: 71, maxPct: 80, isPass: true },
      { label: "B2", minPct: 61, maxPct: 70, isPass: true },
      { label: "C1", minPct: 51, maxPct: 60, isPass: true },
      { label: "C2", minPct: 41, maxPct: 50, isPass: true },
      { label: "D", minPct: 33, maxPct: 40, isPass: true },
      { label: "E", minPct: 0, maxPct: 32, isPass: false },
    ],
  },
  {
    name: "Quiz grades",
    appliesTo: "quiz",
    description: "Grades for quiz results, shown next to pass or fail.",
    bands: [
      { label: "Excellent", minPct: 90, maxPct: 100, isPass: true },
      { label: "Good", minPct: 75, maxPct: 89, isPass: true },
      { label: "Satisfactory", minPct: 60, maxPct: 74, isPass: true },
      { label: "Needs work", minPct: 0, maxPct: 59, isPass: false },
    ],
  },
  {
    name: "Observation levels",
    appliesTo: "observation",
    description: "Levels for a scored classroom observation: the rubric total as a percentage.",
    bands: [
      { label: "Exemplary", minPct: 85, maxPct: 100, isPass: true },
      { label: "Proficient", minPct: 70, maxPct: 84, isPass: true },
      { label: "Developing", minPct: 50, maxPct: 69, isPass: true },
      { label: "Beginning", minPct: 0, maxPct: 49, isPass: true },
    ],
  },
];

export const DEFAULT_RUBRIC = {
  name: "Classroom observation rubric",
  description: "Six criteria an observer scores from 0 to 4 during a classroom observation.",
  scaleName: "Observation levels",
  criteria: [
    {
      title: "Planning and preparation",
      description: "The lesson has clear objectives, and its materials and activities are ready before the class starts.",
    },
    {
      title: "Classroom climate",
      description: "Students are respected and feel safe to speak; routines keep the class calm and focused on learning.",
    },
    {
      title: "Instruction and explanation",
      description: "Explanations are clear, accurate and pitched at the class's level, with examples students recognise.",
    },
    {
      title: "Student engagement",
      description: "Most students are actively working on the task, talking about it and taking part throughout.",
    },
    {
      title: "Checking for understanding",
      description: "The teacher asks questions and looks at students' work during the lesson, and adjusts the teaching.",
    },
    {
      title: "Use of materials",
      description: "Teaching and learning materials are used on purpose to support the lesson's objectives.",
    },
  ],
  maxScore: 4,
} as const;

export type SeedGradingReport = {
  scalesCreated: string[];
  defaultsSet: string[];
  rubricCreated: boolean;
  rubricDefault: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = NodePgDatabase<any>;

/** Seed through `db`. With `dryRun`, report what would be written and write nothing. */
export async function seedGrading(db: AnyDb, opts: { dryRun?: boolean } = {}): Promise<SeedGradingReport> {
  const report: SeedGradingReport = { scalesCreated: [], defaultsSet: [], rubricCreated: false, rubricDefault: false };

  for (const scale of DEFAULT_SCALES) {
    const [existing] = await db
      .select({ id: gradingScales.id })
      .from(gradingScales)
      .where(eq(gradingScales.name, scale.name))
      .limit(1);
    if (existing) continue;
    report.scalesCreated.push(scale.name);
    if (opts.dryRun) continue;
    await db.transaction(async (tx) => {
      const [hasDefault] = await tx
        .select({ id: gradingScales.id })
        .from(gradingScales)
        .where(and(eq(gradingScales.appliesTo, scale.appliesTo), eq(gradingScales.isDefault, true)))
        .limit(1);
      const [row] = await tx
        .insert(gradingScales)
        .values({ name: scale.name, appliesTo: scale.appliesTo, description: scale.description, isDefault: !hasDefault })
        .returning({ id: gradingScales.id });
      await tx.insert(gradingBands).values(
        scale.bands.map((b, i) => ({ scaleId: row!.id, label: b.label, minPct: b.minPct, maxPct: b.maxPct, isPass: b.isPass, sequence: i + 1 })),
      );
      if (!hasDefault) report.defaultsSet.push(scale.name);
    });
  }

  const [rubric] = await db
    .select({ id: observationRubrics.id })
    .from(observationRubrics)
    .where(eq(observationRubrics.name, DEFAULT_RUBRIC.name))
    .limit(1);
  if (!rubric) {
    report.rubricCreated = true;
    if (!opts.dryRun) {
      await db.transaction(async (tx) => {
        const [scale] = await tx
          .select({ id: gradingScales.id })
          .from(gradingScales)
          .where(eq(gradingScales.name, DEFAULT_RUBRIC.scaleName))
          .limit(1);
        const [hasDefault] = await tx
          .select({ id: observationRubrics.id })
          .from(observationRubrics)
          .where(eq(observationRubrics.isDefault, true))
          .limit(1);
        const [row] = await tx
          .insert(observationRubrics)
          .values({
            name: DEFAULT_RUBRIC.name,
            description: DEFAULT_RUBRIC.description,
            gradingScaleId: scale?.id ?? null,
            isDefault: !hasDefault,
          })
          .returning({ id: observationRubrics.id });
        await tx.insert(rubricCriteria).values(
          DEFAULT_RUBRIC.criteria.map((c, i) => ({
            rubricId: row!.id,
            sequence: i + 1,
            title: c.title,
            description: c.description,
            maxScore: DEFAULT_RUBRIC.maxScore,
          })),
        );
        report.rubricDefault = !hasDefault;
      });
    }
  }
  return report;
}

export async function main(): Promise<void> {
  const dryRun = process.env.SEED_DRY_RUN === "true";
  const pool = new Pool(poolConfig());
  try {
    const report = await seedGrading(drizzle(pool), { dryRun });
    console.log(
      `[seed-grading] DONE — scales created: ${report.scalesCreated.join(", ") || "none"}; ` +
        `defaults set: ${report.defaultsSet.join(", ") || "none"}; ` +
        `rubric created: ${report.rubricCreated ? "yes" : "no"}${report.rubricDefault ? " (default)" : ""}` +
        (dryRun ? " (dry-run; no writes)" : ""),
    );
  } finally {
    await pool.end();
  }
}

// Auto-run only when invoked directly, not when seed_all.ts imports it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[seed-grading] failed:", err);
    process.exit(1);
  });
}
