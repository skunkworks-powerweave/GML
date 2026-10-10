// packages/db/src/scripts/seed_grading.ts, EXECUTED: the default scales and
// the default observation rubric a fresh deployment starts with.
//
//   - CBSE 8-point (students), Quiz grades, Observation levels, each complete
//     (every percentage 0-100 in exactly one band), and each the default for
//     what it grades when nothing is yet
//   - the Classroom observation rubric: six criteria, each out of 4, graded on
//     the observation scale, the default rubric when there is none
//   - idempotent by name: a second run writes nothing, and a default an
//     administrator chose is never taken away
//   - wired into seed_all.ts, which runs on every deploy
//
// Everything runs inside a transaction that is rolled back (the seed's own
// transactions become savepoints), so the shared test database is untouched.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { needsDatabase } from "./_harness.js";
import { closeAppDb } from "./_server-actions.js";
import { scaleProblems } from "../../apps/web/src/lib/grading/bands.ts";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

class Rollback extends Error {}

test("the seed makes the three default scales and the default rubric, once, and never takes an administrator's default", { skip }, async () => {
  const { seedGrading, DEFAULT_SCALES, DEFAULT_RUBRIC } = await import("../../packages/db/src/scripts/seed_grading.ts");
  const { db } = await import("@gml/db");
  const { gradingScales, gradingBands, observationRubrics, rubricCriteria } = await import("@gml/db/schema");
  const { and, asc, eq, inArray, sql } = await import("drizzle-orm");
  const names = DEFAULT_SCALES.map((s) => s.name);

  await db
    .transaction(async (tx) => {
      // The seed asks "is there a default already?" across the whole table,
      // and other files commit their own quiz default (admin-platform-entities):
      // hold off every other write to grading_scales until this transaction
      // rolls back, so no default appears between clearing them and seeding.
      // EXCLUSIVE, not SHARE ROW EXCLUSIVE: clearing that file's default needs
      // its row, which its edit holds FOR UPDATE before writing; this waits for
      // the edit to finish instead of deadlocking with it. Plain reads are not
      // blocked.
      await tx.execute(sql`LOCK TABLE grading_scales IN EXCLUSIVE MODE`);
      // As on a fresh deployment: none of the seed's rows, no defaults.
      await tx.delete(observationRubrics).where(eq(observationRubrics.name, DEFAULT_RUBRIC.name));
      await tx.delete(gradingScales).where(inArray(gradingScales.name, names));
      await tx.update(gradingScales).set({ isDefault: false }).where(eq(gradingScales.isDefault, true));
      await tx.update(observationRubrics).set({ isDefault: false }).where(eq(observationRubrics.isDefault, true));

      const dry = await seedGrading(tx as never, { dryRun: true });
      assert.deepEqual(dry.scalesCreated, names);
      assert.equal((await tx.select().from(gradingScales).where(inArray(gradingScales.name, names))).length, 0, "a dry run writes nothing");

      const first = await seedGrading(tx as never);
      assert.deepEqual(first, { scalesCreated: names, defaultsSet: names, rubricCreated: true, rubricDefault: true });

      const bandsOf = async (name: string) => {
        const [s] = await tx.select().from(gradingScales).where(eq(gradingScales.name, name));
        const bands = await tx.select().from(gradingBands).where(eq(gradingBands.scaleId, s!.id)).orderBy(asc(gradingBands.sequence));
        return { scale: s!, bands };
      };
      const cbse = await bandsOf("CBSE 8-point");
      assert.equal(cbse.scale.appliesTo, "student");
      assert.equal(cbse.scale.isDefault, true);
      assert.deepEqual(
        cbse.bands.map((b) => [b.label, b.minPct, b.maxPct, b.isPass]),
        [
          ["A1", 91, 100, true],
          ["A2", 81, 90, true],
          ["B1", 71, 80, true],
          ["B2", 61, 70, true],
          ["C1", 51, 60, true],
          ["C2", 41, 50, true],
          ["D", 33, 40, true],
          ["E", 0, 32, false],
        ],
      );
      const quiz = await bandsOf("Quiz grades");
      assert.deepEqual(quiz.bands.map((b) => [b.label, b.minPct, b.maxPct, b.isPass]), [
        ["Excellent", 90, 100, true],
        ["Good", 75, 89, true],
        ["Satisfactory", 60, 74, true],
        ["Needs work", 0, 59, false],
      ]);
      const obs = await bandsOf("Observation levels");
      assert.deepEqual(obs.bands.map((b) => [b.label, b.minPct, b.maxPct]), [
        ["Exemplary", 85, 100],
        ["Proficient", 70, 84],
        ["Developing", 50, 69],
        ["Beginning", 0, 49],
      ]);
      for (const s of [cbse, quiz, obs]) assert.deepEqual(scaleProblems(s.bands), { gaps: [], overlaps: [] }, `${s.scale.name} is complete`);
      assert.deepEqual([quiz.scale.appliesTo, quiz.scale.isDefault, obs.scale.appliesTo, obs.scale.isDefault], ["quiz", true, "observation", true]);

      const [rubric] = await tx.select().from(observationRubrics).where(eq(observationRubrics.name, "Classroom observation rubric"));
      assert.equal(rubric!.isDefault, true);
      assert.equal(rubric!.gradingScaleId, obs.scale.id, "graded on the observation scale");
      const criteria = await tx.select().from(rubricCriteria).where(eq(rubricCriteria.rubricId, rubric!.id)).orderBy(asc(rubricCriteria.sequence));
      assert.deepEqual(
        criteria.map((c) => [c.title, c.maxScore]),
        [
          ["Planning and preparation", 4],
          ["Classroom climate", 4],
          ["Instruction and explanation", 4],
          ["Student engagement", 4],
          ["Checking for understanding", 4],
          ["Use of materials", 4],
        ],
      );
      assert.ok(criteria.every((c) => (c.description ?? "").length > 10), "each says what good looks like");

      // Again: nothing to do.
      assert.deepEqual(await seedGrading(tx as never), { scalesCreated: [], defaultsSet: [], rubricCreated: false, rubricDefault: false });
      assert.equal((await tx.select().from(gradingBands).where(eq(gradingBands.scaleId, cbse.scale.id))).length, 8, "bands are not added twice");

      // An administrator's edits and default survive a deploy.
      await tx.update(gradingBands).set({ label: "Top" }).where(and(eq(gradingBands.scaleId, cbse.scale.id), eq(gradingBands.label, "A1")));
      await tx.delete(gradingScales).where(eq(gradingScales.name, "Quiz grades"));
      const [mine] = await tx.insert(gradingScales).values({ name: `Mine ${Date.now()}`, appliesTo: "quiz", isDefault: true }).returning({ id: gradingScales.id });
      const third = await seedGrading(tx as never);
      assert.deepEqual(third.scalesCreated, ["Quiz grades"], "a deleted default scale comes back");
      assert.deepEqual(third.defaultsSet, [], "but it does not take the administrator's default");
      const [stillMine] = await tx.select().from(gradingScales).where(and(eq(gradingScales.appliesTo, "quiz"), eq(gradingScales.isDefault, true)));
      assert.equal(stillMine!.id, mine!.id);
      assert.equal(
        (await tx.select().from(gradingBands).where(and(eq(gradingBands.scaleId, cbse.scale.id), eq(gradingBands.label, "Top")))).length,
        1,
        "an edited band is left as the administrator made it",
      );
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
});

test("seed_all.ts runs the grading seed, after the others", () => {
  const src = readFileSync(new URL("../../packages/db/src/scripts/seed_all.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ main as seedGrading \} from "\.\/seed_grading\.js";/);
  const phases = src.slice(src.indexOf("const PHASES"));
  assert.ok(phases.indexOf(`name: "seed_grading"`) > phases.indexOf(`name: "seed_forms_misc"`), "the grading phase is in the list, last");
});
