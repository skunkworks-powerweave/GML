// /admin/grading, EXECUTED: grade scales and observation rubrics, through the
// real server actions and lib/grading/admin.ts, against Postgres.
//
//   - who may change grading at all (programme admin, super admin; a teacher
//     or a mentor is refused by the action and by the library)
//   - a scale's bands: saved in order, refused when a band is malformed,
//     saved WITH a warning when they leave gaps or overlaps
//   - one default per kind, swapped in one transaction; switching the default
//     off leaves its kind with none; a switched-off scale cannot be the default
//   - a scale that anything names cannot be deleted
//   - a rubric's criteria are edited in place (scores stay attached through a
//     reorder), a scored criterion cannot be removed or have its maximum
//     lowered below a score, and a scored rubric cannot be deleted
//   - every write is audited with the metadata docs/audit-actions.md lists
//   - the pages render, in Hindi and Bhoti too, and fit a phone
//
// Committed rows are tagged and removed afterwards. The default-swapping
// tests run inside a transaction that is rolled back, so the shared test
// database's real defaults are never taken away from other test files.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { render, request, resetRequest } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, form, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, outcome, signIn } from "./_server-actions.js";
import { phoneLayoutIssues } from "./_phone-layout.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const actions = () => import("../../apps/web/src/app/(authenticated)/admin/grading/actions.ts");
const lib = () => import("../../apps/web/src/lib/grading/admin.ts");
const scalesLib = () => import("../../apps/web/src/lib/grading/scales.ts");
const indexPage = () => import("../../apps/web/src/app/(authenticated)/admin/grading/page.tsx");
const scalePage = () => import("../../apps/web/src/app/(authenticated)/admin/grading/scales/[id]/page.tsx");
const rubricPage = () => import("../../apps/web/src/app/(authenticated)/admin/grading/rubrics/[id]/page.tsx");

const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");

/** The audit row `action` wrote for `entityId`, its metadata keys checked against the taxonomy. */
async function audited(c: Client, action: string, entityId: string, where: Record<string, unknown> = {}) {
  const { rows } = await c.query(
    `SELECT user_id, entity_type, metadata FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY created_at DESC`,
    [action, entityId],
  );
  const row = rows.find((r) => Object.entries(where).every(([k, v]) => r.metadata[k] === v));
  assert.ok(row, `${action} was not audited for ${entityId} with ${JSON.stringify(where)}`);
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${action}\` |`));
  assert.ok(line, `${action} is not documented in docs/audit-actions.md`);
  const documented = new Set([...line!.split("|")[3]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]));
  for (const key of Object.keys(row.metadata)) assert.ok(documented.has(key), `${action}: metadata key ${key} is not documented`);
  return row as { user_id: string; entity_type: string; metadata: Record<string, unknown> };
}

type Returned = { ok: boolean; message: string };
async function returned(p: Promise<unknown>): Promise<Returned> {
  const o = await outcome(() => p);
  assert.equal(o.kind, "returned", `expected the action to answer, got ${JSON.stringify(o)}`);
  return (o as { value: Returned }).value;
}

async function admin(f: Fixture, role = "programme_admin") {
  const id = await f.user(role, role);
  return { id, role };
}

/** Run `body` on a transaction of the app's pool that is always rolled back. */
class Rollback extends Error {}
async function rolledBack(body: (tx: never) => Promise<void>): Promise<void> {
  const { db } = await import("@gml/db");
  await db
    .transaction(async (tx) => {
      await body(tx as never);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

test("a programme admin creates a scale and saves its bands; gaps are a warning, malformed bands are refused", { skip }, async () => {
  const a = await actions();
  await withClient(async (c) => {
    const t = tag("gscale");
    const f = fixture(c, t);
    f.defer(`DELETE FROM grading_scales WHERE name LIKE $1`, [`%${t}%`]);
    try {
      const pa = await admin(f);
      signIn(pa);
      const created = await outcome(() =>
        a.createScaleAction(undefined, form({ name: `Report card ${t}`, appliesTo: "student", description: "Term reports" })),
      );
      assert.equal(created.kind, "redirect");
      const id = (created as { location: string }).location.match(/\/admin\/grading\/scales\/([0-9a-f-]{36})$/)?.[1];
      assert.ok(id, `created: ${JSON.stringify(created)}`);
      const [row] = (await c.query(`SELECT applies_to, is_default, active FROM grading_scales WHERE id = $1`, [id])).rows;
      assert.deepEqual(row, { applies_to: "student", is_default: false, active: true }, "a new scale is not the default until chosen");
      assert.equal((await audited(c, "grading.scale.saved", id!, { change: "created" })).user_id, pa.id);

      // Two bands that leave 41-49 without a grade: saved, with the gap named.
      const gappy = await returned(
        a.saveBandsAction(undefined, form({ scaleId: id!, label: ["Pass", "Fail"], min: ["50", "0"], max: ["100", "40"], pass: ["1", "0"] })),
      );
      assert.equal(gappy.ok, true);
      assert.match(gappy.message, /No grade for: 41–49/);
      const bands = (await c.query(`SELECT label, min_pct, max_pct, is_pass, sequence FROM grading_bands WHERE scale_id = $1 ORDER BY sequence`, [id])).rows;
      assert.deepEqual(bands, [
        { label: "Pass", min_pct: 50, max_pct: 100, is_pass: true, sequence: 1 },
        { label: "Fail", min_pct: 0, max_pct: 40, is_pass: false, sequence: 2 },
      ]);
      const bandsRow = await audited(c, "grading.scale.saved", id!, { change: "bands" });
      assert.equal(bandsRow.metadata.gaps, 9);
      assert.equal(bandsRow.metadata.overlaps, 0);
      // The list counts them. Its correlated count once compared the band's
      // own id with itself (drizzle leaves a single-table select's columns
      // unqualified), so every scale read "0 bands".
      const listed = (await (await lib()).listScales((await import("@gml/db")).db as never)).find((s) => s.id === id);
      assert.equal(listed?.bandCount, 2);

      // The page shows the saved gap.
      const { default: ScalePage } = await scalePage();
      const withGap = await render(await ScalePage({ params: Promise.resolve({ id: id! }) }));
      assert.match(withGap, /data-testid="saved-problems"[^>]*>.*No grade for: 41–49/s);

      // Malformed: backwards range, a duplicate label, an empty list. Nothing changes.
      const backwards = await returned(
        a.saveBandsAction(undefined, form({ scaleId: id!, label: ["Pass"], min: ["60"], max: ["50"], pass: ["1"] })),
      );
      assert.equal(backwards.ok, false);
      assert.match(backwards.message, /Band 1 \(Pass\)/);
      const twice = await returned(
        a.saveBandsAction(undefined, form({ scaleId: id!, label: ["A", "a"], min: ["50", "0"], max: ["100", "49"], pass: ["1", "0"] })),
      );
      assert.equal(twice.ok, false);
      assert.match(twice.message, /used twice/);
      const none = await returned(a.saveBandsAction(undefined, form({ scaleId: id!, label: [""], min: [""], max: [""], pass: ["1"] })));
      assert.equal(none.ok, false);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM grading_bands WHERE scale_id = $1`, [id])).rows[0].n, 2);

      // Complete: every percentage has exactly one grade.
      const whole = await returned(
        a.saveBandsAction(undefined, form({ scaleId: id!, label: ["Pass", "Fail"], min: ["41", "0"], max: ["100", "40"], pass: ["1", "0"] })),
      );
      assert.deepEqual(whole, { ok: true, message: "Saved 2 bands." });
      const clean = await render(await ScalePage({ params: Promise.resolve({ id: id! }) }));
      assert.doesNotMatch(clean, /saved-problems/);
      assert.match(clean, /Every percentage from 0 to 100 has exactly one grade/);

      // Renaming keeps what it grades.
      const renamed = await returned(a.saveScaleDetailsAction(undefined, form({ scaleId: id!, name: `Renamed ${t}`, description: "" })));
      assert.equal(renamed.ok, true);
      assert.equal((await c.query(`SELECT name, applies_to FROM grading_scales WHERE id = $1`, [id])).rows[0].name, `Renamed ${t}`);
      // A second scale may not take the same name.
      const dup = await returned(a.createScaleAction(undefined, form({ name: `Renamed ${t}`, appliesTo: "quiz" })));
      assert.equal(dup.ok, false);
      assert.match(dup.message, /already used/);
    } finally {
      await f.cleanup();
    }
  });
});

test("only a programme admin or a super admin may change grading: the action and the library both refuse anyone else", { skip }, async () => {
  const a = await actions();
  const l = await lib();
  const { db } = await import("@gml/db");
  await withClient(async (c) => {
    const t = tag("groles");
    const f = fixture(c, t);
    f.defer(`DELETE FROM grading_scales WHERE name LIKE $1`, [`%${t}%`]);
    try {
      for (const role of ["teacher", "mentor", "observer"]) {
        const u = { id: await f.user(role, `${role}x`), role };
        signIn(u);
        assert.deepEqual(
          await outcome(() => a.createScaleAction(undefined, form({ name: `Nope ${role} ${t}`, appliesTo: "student" }))),
          { kind: "redirect", location: "/forbidden" },
          `a ${role} cannot create a scale`,
        );
        const { default: Index } = await indexPage();
        assert.deepEqual(await outcome(() => Index({ searchParams: Promise.resolve({}) })), { kind: "redirect", location: "/forbidden" });
        const lr = await l.saveScale(db as never, u, { name: `Lib ${role} ${t}`, appliesTo: "student" });
        assert.deepEqual(lr, { ok: false, error: "not_allowed", detail: undefined });
      }
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM grading_scales WHERE name LIKE $1`, [`%${t}%`])).rows[0].n, 0);
      // A super admin may.
      signIn(await admin(f, "super_admin"));
      const ok = await outcome(() => a.createScaleAction(undefined, form({ name: `Super ${t}`, appliesTo: "quiz" })));
      assert.equal(ok.kind, "redirect");
    } finally {
      await f.cleanup();
    }
  });
});

test("one default per kind: making a scale the default takes it from the previous one; a switched-off scale cannot be it", { skip }, async () => {
  const l = await lib();
  const { resolveScale } = await scalesLib();
  const { gradingScales, gradingBands } = await import("@gml/db/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  await withClient(async (c) => {
    const t = tag("gdef");
    const f = fixture(c, t);
    try {
      const pa = await admin(f);
      await rolledBack(async (tx: never) => {
        const d = tx as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<Record<string, unknown>>;
        // "Other kinds are untouched" reads the quiz default across the whole
        // table, twice, and other files commit and delete their own quiz
        // default (admin-platform-entities): hold off every other write to
        // grading_scales until this transaction rolls back, so the two reads
        // see the same table. Plain reads and foreign-key checks are not blocked.
        await d.execute(sql`LOCK TABLE grading_scales IN SHARE ROW EXCLUSIVE MODE`);
        const make = async (name: string, appliesTo: "student" | "quiz") => {
          const [row] = await d.insert(gradingScales).values({ name: `${name} ${t}`, appliesTo }).returning({ id: gradingScales.id });
          await d.insert(gradingBands).values({ scaleId: row!.id, label: "All", minPct: 0, maxPct: 100, isPass: true, sequence: 1 });
          return row!.id;
        };
        const quizDefaultBefore = await d
          .select({ id: gradingScales.id })
          .from(gradingScales)
          .where(and(eq(gradingScales.appliesTo, "quiz"), eq(gradingScales.isDefault, true)));
        const A = await make("A", "student");
        const B = await make("B", "student");
        const defaults = async () =>
          (await d.select({ id: gradingScales.id }).from(gradingScales).where(and(eq(gradingScales.appliesTo, "student"), eq(gradingScales.isDefault, true)))).map(
            (r) => r.id,
          );

        const first = await l.setDefaultScale(d as never, pa, A);
        assert.equal(first.ok, true);
        assert.deepEqual(await defaults(), [A]);
        const second = await l.setDefaultScale(d as never, pa, B);
        assert.deepEqual(second, { ok: true, id: B, previousId: A });
        assert.deepEqual(await defaults(), [B], "exactly one default for students, the new one");
        assert.equal((await resolveScale(d as never, "student"))?.id, B, "what names no scale is graded with the default");
        assert.equal((await resolveScale(d as never, "student", A))?.id, A, "what names one is graded with it");
        // Other kinds are untouched.
        const quizDefaultAfter = await d
          .select({ id: gradingScales.id })
          .from(gradingScales)
          .where(and(eq(gradingScales.appliesTo, "quiz"), eq(gradingScales.isDefault, true)));
        assert.deepEqual(quizDefaultAfter, quizDefaultBefore);

        // Switching the default off leaves students with no default.
        const off = await l.setScaleActive(d as never, pa, B, false);
        assert.deepEqual(off, { ok: true, id: B, defaultCleared: true });
        assert.deepEqual(await defaults(), []);
        assert.equal(await resolveScale(d as never, "student"), null);
        // ... and it cannot be made the default while off.
        assert.deepEqual(await l.setDefaultScale(d as never, pa, B), { ok: false, error: "inactive_default", detail: undefined });
        assert.equal((await l.setScaleActive(d as never, pa, B, true)).ok, true);
        assert.equal((await l.setDefaultScale(d as never, pa, B)).ok, true);
        assert.deepEqual(await defaults(), [B]);
      });
    } finally {
      await f.cleanup();
    }
  });
});

test("a scale that anything names cannot be deleted; an unused one is deleted with its bands", { skip }, async () => {
  const a = await actions();
  await withClient(async (c) => {
    const t = tag("gdel");
    const f = fixture(c, t);
    f.defer(`DELETE FROM grading_scales WHERE name LIKE $1`, [`%${t}%`]);
    try {
      signIn(await admin(f));
      const made = await outcome(() => a.createScaleAction(undefined, form({ name: `Levels ${t}`, appliesTo: "observation" })));
      const id = (made as { location: string }).location.split("/").pop()!;
      await returned(a.saveBandsAction(undefined, form({ scaleId: id, label: ["All"], min: ["0"], max: ["100"], pass: ["1"] })));
      const rubric = await f.row("observation_rubrics", { name: `Uses it ${t}`, grading_scale_id: id });

      const refused = await returned(a.deleteScaleAction(undefined, form({ scaleId: id })));
      assert.equal(refused.ok, false);
      assert.match(refused.message, /cannot be deleted while it is in use: 0 assessments, 0 quizzes and 1 rubric/);
      const { default: ScalePage } = await scalePage();
      assert.match(await render(await ScalePage({ params: Promise.resolve({ id }) })), /1 rubric name it/);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM grading_scales WHERE id = $1`, [id])).rows[0].n, 1);

      await c.query(`DELETE FROM observation_rubrics WHERE id = $1`, [rubric]);
      assert.deepEqual(await outcome(() => a.deleteScaleAction(undefined, form({ scaleId: id }))), {
        kind: "redirect",
        location: "/admin/grading?deleted=scale",
      });
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM grading_bands WHERE scale_id = $1`, [id])).rows[0].n, 0);
      const row = await audited(c, "grading.scale.deleted", id);
      assert.deepEqual(row.metadata, { name: `Levels ${t}`, appliesTo: "observation" });
    } finally {
      await f.cleanup();
    }
  });
});

test("a rubric's criteria are edited in place; scored criteria stay, and a scored rubric cannot be deleted", { skip }, async () => {
  const a = await actions();
  await withClient(async (c) => {
    const t = tag("grub");
    const f = fixture(c, t);
    f.defer(`DELETE FROM observation_rubrics WHERE name LIKE $1`, [`%${t}%`]);
    try {
      const pa = await admin(f);
      signIn(pa);
      const made = await outcome(() =>
        a.createRubricAction(undefined, form({ name: `Walkthrough ${t}`, description: "Short visits", gradingScaleId: "" })),
      );
      assert.equal(made.kind, "redirect");
      const id = (made as { location: string }).location.match(/\/admin\/grading\/rubrics\/([0-9a-f-]{36})$/)?.[1]!;
      await audited(c, "grading.rubric.saved", id, { change: "created" });

      // Criteria: a maximum of 11 is refused; three good ones are saved in order.
      const tooHigh = await returned(
        a.saveCriteriaAction(undefined, form({ rubricId: id, criterionId: [""], title: ["Pace"], description: [""], maxScore: ["11"] })),
      );
      assert.equal(tooHigh.ok, false);
      assert.match(tooHigh.message, /Criterion 1 \(Pace\)/);
      const saved = await returned(
        a.saveCriteriaAction(
          undefined,
          form({ rubricId: id, criterionId: ["", "", ""], title: ["Pace", "Questions", "Materials"], description: ["", "Open questions", ""], maxScore: ["4", "4", "3"] }),
        ),
      );
      assert.deepEqual(saved, { ok: true, message: "Saved 3 criteria." });
      const crit = (await c.query(`SELECT id, title, sequence, max_score FROM rubric_criteria WHERE rubric_id = $1 ORDER BY sequence`, [id])).rows;
      assert.deepEqual(crit.map((r) => [r.title, r.sequence, r.max_score]), [["Pace", 1, 4], ["Questions", 2, 4], ["Materials", 3, 3]]);
      const [pace, questions, materials] = crit.map((r) => r.id as string);
      await audited(c, "grading.rubric.saved", id, { change: "criteria" });

      // An observation scores "Questions" 3.
      const district = await f.row("districts", { name: `D ${t}`, code: `D${t.slice(-8)}` });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: `S${t.slice(-8)}` });
      const teacher = await f.row("teachers", { school_id: school, full_name: `T ${t}` });
      const cycle = await f.row("observation_cycles", { code: `OBS-${t}`, teacher_id: teacher, kind: "baseline", rubric_id: id });
      await f.row("observation_scores", { cycle_id: cycle, criterion_id: questions, score: 3 });

      // Reordered and renamed: the same rows, so the score stays attached.
      const moved = await returned(
        a.saveCriteriaAction(
          undefined,
          form({
            rubricId: id,
            criterionId: [questions!, pace!, materials!],
            title: ["Questioning", "Pace", "Materials"],
            description: ["Open questions", "", ""],
            maxScore: ["4", "4", "3"],
          }),
        ),
      );
      assert.equal(moved.ok, true, moved.message);
      const after = (await c.query(`SELECT id, title, sequence FROM rubric_criteria WHERE rubric_id = $1 ORDER BY sequence`, [id])).rows;
      assert.deepEqual(after.map((r) => [r.id, r.title]), [[questions, "Questioning"], [pace, "Pace"], [materials, "Materials"]]);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM observation_scores WHERE criterion_id = $1`, [questions])).rows[0].n, 1);
      // And the rubric page's criteria know which one was scored.
      const detail = await (await lib()).rubricDetail((await import("@gml/db")).db as never, id!);
      assert.deepEqual(
        detail?.criteria.map((cr) => [cr.title, cr.scored]),
        [["Questioning", 1], ["Pace", 0], ["Materials", 0]],
      );

      // The scored criterion cannot be removed, nor its maximum lowered below its score.
      const remove = await returned(
        a.saveCriteriaAction(undefined, form({ rubricId: id, criterionId: [pace!, materials!], title: ["Pace", "Materials"], description: ["", ""], maxScore: ["4", "3"] })),
      );
      assert.equal(remove.ok, false);
      assert.match(remove.message, /Questioning has already been scored/);
      const lower = await returned(
        a.saveCriteriaAction(
          undefined,
          form({ rubricId: id, criterionId: [questions!, pace!, materials!], title: ["Questioning", "Pace", "Materials"], description: ["", "", ""], maxScore: ["2", "4", "3"] }),
        ),
      );
      assert.equal(lower.ok, false);
      assert.match(lower.message, /already gave it 3/);
      // An unscored criterion can go.
      const dropMaterials = await returned(
        a.saveCriteriaAction(undefined, form({ rubricId: id, criterionId: [questions!, pace!], title: ["Questioning", "Pace"], description: ["", ""], maxScore: ["4", "4"] })),
      );
      assert.equal(dropMaterials.ok, true, dropMaterials.message);

      // Deleting is refused, with a clear reason, on the page and from the action.
      const refused = await returned(a.deleteRubricAction(undefined, form({ rubricId: id })));
      assert.equal(refused.ok, false);
      assert.match(refused.message, /cannot be deleted: 1 observation has been scored with it/);
      const { default: RubricPage } = await rubricPage();
      const html = await render(await RubricPage({ params: Promise.resolve({ id }) }));
      assert.match(html, /data-testid="rubric-delete-refused"/);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM observation_rubrics WHERE id = $1`, [id])).rows[0].n, 1);

      // Once the score is gone, it can be deleted, criteria and all.
      await c.query(`DELETE FROM observation_scores WHERE cycle_id = $1`, [cycle]);
      assert.deepEqual(await outcome(() => a.deleteRubricAction(undefined, form({ rubricId: id }))), {
        kind: "redirect",
        location: "/admin/grading?deleted=rubric",
      });
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM rubric_criteria WHERE rubric_id = $1`, [id])).rows[0].n, 0);
      assert.deepEqual((await audited(c, "grading.rubric.deleted", id)).metadata, { name: `Walkthrough ${t}`, criteria: 2 });
    } finally {
      await f.cleanup();
    }
  });
});

test("one default rubric: making one the default takes it from the other, and a rubric's scale must grade observations", { skip }, async () => {
  const l = await lib();
  const { observationRubrics, gradingScales } = await import("@gml/db/schema");
  const { eq } = await import("drizzle-orm");
  await withClient(async (c) => {
    const t = tag("grdef");
    const f = fixture(c, t);
    try {
      const pa = await admin(f);
      await rolledBack(async (tx: never) => {
        const d = tx as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<Record<string, unknown>>;
        const [studentScale] = await d.insert(gradingScales).values({ name: `Student ${t}`, appliesTo: "student" }).returning({ id: gradingScales.id });
        assert.deepEqual(
          await l.saveRubric(d as never, pa, { name: `Wrong ${t}`, gradingScaleId: studentScale!.id }),
          { ok: false, error: "wrong_scale_kind", detail: undefined },
        );
        const one = await l.saveRubric(d as never, pa, { name: `One ${t}`, makeDefault: true });
        const two = await l.saveRubric(d as never, pa, { name: `Two ${t}` });
        assert.ok(one.ok && two.ok);
        const defaults = async () =>
          (await d.select({ id: observationRubrics.id }).from(observationRubrics).where(eq(observationRubrics.isDefault, true))).map((r) => r.id);
        assert.deepEqual(await defaults(), [one.ok ? one.id : ""]);
        const swapped = await l.setDefaultRubric(d as never, pa, two.ok ? two.id : "");
        assert.deepEqual(swapped, { ok: true, id: two.ok ? two.id : "", previousId: one.ok ? one.id : "" });
        assert.deepEqual(await defaults(), [two.ok ? two.id : ""]);
        const off = await l.setRubricActive(d as never, pa, two.ok ? two.id : "", false);
        assert.deepEqual(off, { ok: true, id: two.ok ? two.id : "", defaultCleared: true });
        assert.deepEqual(await defaults(), []);
      });
    } finally {
      await f.cleanup();
    }
  });
});

test("the grading pages render in Hindi and Bhoti, and the scale editor fits a phone", { skip }, async () => {
  const a = await actions();
  await withClient(async (c) => {
    const t = tag("gi18n");
    const f = fixture(c, t);
    f.defer(`DELETE FROM grading_scales WHERE name LIKE $1`, [`%${t}%`]);
    try {
      signIn(await admin(f));
      const made = await outcome(() => a.createScaleAction(undefined, form({ name: `Phone ${t}`, appliesTo: "quiz" })));
      const id = (made as { location: string }).location.split("/").pop()!;
      await returned(a.saveBandsAction(undefined, form({ scaleId: id, label: ["Top", "Rest"], min: ["80", "0"], max: ["100", "79"], pass: ["1", "0"] })));

      const { default: Index } = await indexPage();
      request.locale = "bo";
      const bo = await render(await Index({ searchParams: Promise.resolve({}) }));
      assert.match(bo, /སྐར་རིམ་གྱི་ཚད་ཐིག་དང་ཚད་གཞི།/, "the Bhoti heading");
      assert.match(bo, new RegExp(`Phone ${t}`), "the scale's own name, as entered");
      request.locale = "hi";
      const { default: ScalePage } = await scalePage();
      const hi = await render(await ScalePage({ params: Promise.resolve({ id }) }));
      assert.match(hi, /बैंड सहेजें/, "the editor's Hindi save button");
      assert.match(hi, /हमेशा के लिए हटाएँ|यह स्केल हटाएँ/, "the Hindi delete control");
      assert.deepEqual(await phoneLayoutIssues(hi), [], "the scale page fits a 360px phone");
    } finally {
      resetRequest();
      await f.cleanup();
    }
  });
});
