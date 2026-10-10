// A quiz result's grade, EXECUTED: the result and history pages show the band
// the score falls in -- the quiz's own scale (quizzes.grading_scale_id), else
// the default quiz scale -- next to the existing pass/fail; the admin quiz
// editor chooses the scale, audited, refused for a scale of another kind and
// for anyone but a programme admin.
//
// The quiz and its scale are committed under a tag and removed afterwards.
// The default-scale fallback is checked inside a rolled-back transaction, so
// the shared database's own default quiz scale is never touched.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import type { Client } from "pg";
import { render, renderSync, request, resetRequest, withAppRouter } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, form, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, outcome, signIn } from "./_server-actions.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const resultModule = () => import("../../apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx");
const historyModule = () => import("../../apps/web/src/app/(authenticated)/quizzes/[slug]/history/page.tsx");
const editorModule = () => import("../../apps/web/src/app/(authenticated)/admin/quizzes/[id]/page.tsx");
const actions = () => import("../../apps/web/src/app/(authenticated)/admin/grading/actions.ts");

type World = { f: Fixture; t: string; slug: string; quizId: string; learner: string; scale: string; studentScale: string };

async function world(c: Client, t: string): Promise<World> {
  const f = fixture(c, t);
  const phase = await f.row("phases", { label: t.slice(-24), sequence: 2_000_000 + randomInt(1_000_000_000) });
  const term = await f.row("terms", { phase_id: phase, name: `Term ${t}`, sequence: 1 });
  const subject = await f.row("rtt_subjects", { term_id: term, name: `Subject ${t}` });
  const scale = await f.row("grading_scales", { name: `Quiz levels ${t}`, applies_to: "quiz" });
  for (const [i, [label, min, max, pass]] of ([["Top", 90, 100, true], ["Middle", 60, 89, true], ["Low", 0, 59, false]] as const).entries()) {
    await f.row("grading_bands", { scale_id: scale, label, min_pct: min, max_pct: max, is_pass: pass, sequence: i + 1 });
  }
  const studentScale = await f.row("grading_scales", { name: `Student ${t}`, applies_to: "student" });
  const quizId = await f.row("quizzes", { slug: t, title: `Quiz ${t}`, rtt_subject_id: subject, pass_threshold: 60, active: true, grading_scale_id: scale });
  const learner = await f.user("teacher", "learner");
  f.defer(`DELETE FROM quiz_submissions WHERE quiz_id = $1`, [quizId]);
  return { f, t, slug: t, quizId, learner, scale, studentScale };
}

async function submission(c: Client, w: World, score: number, minutesAgo: number): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO quiz_submissions (quiz_id, user_id, answers, question_snapshot, score, passed, submitted_at)
       VALUES ($1, $2, '[]'::jsonb, '[]'::jsonb, $3, $4, now() - make_interval(mins => $5)) RETURNING id`,
    [w.quizId, w.learner, score, score >= 60, minutesAgo],
  );
  return rows[0].id;
}

test("the result and history pages show the quiz scale's band next to pass or fail", { skip }, async () => {
  await withClient(async (c) => {
    const w = await world(c, tag("gquiz"));
    try {
      const top = await submission(c, w, 92, 30);
      const low = await submission(c, w, 40, 20);
      await submission(c, w, 75, 10);
      signIn({ id: w.learner, role: "teacher" });
      const { default: Result } = await resultModule();
      const passed = renderSync(await Result({ params: Promise.resolve({ slug: w.slug, submissionId: top }) }));
      assert.match(passed, /data-testid="quiz-result-grade"[^>]*>Grade: Top</);
      assert.match(passed, /92%/, "the score is still shown");
      const failed = renderSync(await Result({ params: Promise.resolve({ slug: w.slug, submissionId: low }) }));
      assert.match(failed, /data-testid="quiz-result-grade"[^>]*>Grade: Low</);

      const { default: History } = await historyModule();
      const history = renderSync(await History({ params: Promise.resolve({ slug: w.slug }) }));
      const grades = [...history.matchAll(/data-testid="quiz-history-grade"[^>]*>([^<]*)</g)].map((m) => m[1]);
      assert.deepEqual(grades, ["Middle", "Low", "Top"], "newest first, each attempt with its band");
      assert.match(history, /<th>Grade<\/th>/);

      // In Bhoti, the grade's label is the scale's own; the word around it is translated.
      request.locale = "bo";
      const bo = renderSync(await Result({ params: Promise.resolve({ slug: w.slug, submissionId: top }) }));
      assert.match(bo, /སྐར་རིམ། Top/);
    } finally {
      resetRequest();
      await w.f.cleanup();
    }
  });
});

test("a quiz that names no scale is graded with the default quiz scale, and with none there is no grade", { skip }, async () => {
  const { quizGrader } = await import("../../apps/web/src/lib/grading/quiz.ts");
  const { db } = await import("@gml/db");
  const { gradingScales, gradingBands } = await import("@gml/db/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  class Rollback extends Error {}
  const t = tag("gqdef");
  await db
    .transaction(async (tx) => {
      // The default is read across the whole table, and other files commit
      // their own quiz default (admin-platform-entities): hold off every other
      // write to grading_scales until this transaction rolls back, so none
      // appears between clearing the defaults and reading them. EXCLUSIVE, not
      // SHARE ROW EXCLUSIVE: clearing that file's default needs its row, which
      // its edit holds FOR UPDATE before writing; this waits for the edit to
      // finish instead of deadlocking with it. Plain reads are not blocked.
      await tx.execute(sql`LOCK TABLE grading_scales IN EXCLUSIVE MODE`);
      // Nothing is the default: no grade, only the score.
      await tx.update(gradingScales).set({ isDefault: false }).where(and(eq(gradingScales.appliesTo, "quiz"), eq(gradingScales.isDefault, true)));
      const none = await quizGrader(tx as never, { gradingScaleId: null });
      assert.equal(none.scale, null);
      assert.equal(none.bandOf(95), null);
      // A default: what names no scale is graded with it.
      const [s] = await tx.insert(gradingScales).values({ name: `Default ${t}`, appliesTo: "quiz", isDefault: true }).returning({ id: gradingScales.id });
      await tx.insert(gradingBands).values([
        { scaleId: s!.id, label: "Pass", minPct: 60, maxPct: 100, isPass: true, sequence: 1 },
        { scaleId: s!.id, label: "Fail", minPct: 0, maxPct: 59, isPass: false, sequence: 2 },
      ]);
      const def = await quizGrader(tx as never, { gradingScaleId: null });
      assert.equal(def.scale?.id, s!.id);
      assert.equal(def.bandOf(59.5)?.label, "Pass", "59.5% rounds to 60");
      assert.equal(def.bandOf(59.4)?.label, "Fail");
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
});

test("the admin quiz editor chooses the quiz's scale: audited, a scale of another kind refused, and only for an administrator", { skip }, async () => {
  const a = await actions();
  await withClient(async (c) => {
    const w = await world(c, tag("gqed"));
    try {
      const pa = await w.f.user("programme_admin", "pa");
      signIn({ id: pa, role: "programme_admin" });
      const { default: Editor } = await editorModule();
      const html = await render(withAppRouter(await Editor({ params: Promise.resolve({ id: w.quizId }) })));
      assert.match(html, /data-testid="quiz-grading-scale"/);
      assert.match(html, new RegExp(`<option value="${w.scale}" selected="">Quiz levels ${w.t}</option>`), "the quiz's own scale is the one chosen");

      // Back to the default quiz scale.
      const cleared = await outcome(() => a.setQuizScaleAction(undefined, form({ quizId: w.quizId, gradingScaleId: "" })));
      assert.deepEqual(cleared, { kind: "returned", value: { ok: true, message: "Saved. Results of this quiz are graded with this scale." } });
      assert.equal((await c.query(`SELECT grading_scale_id FROM quizzes WHERE id = $1`, [w.quizId])).rows[0].grading_scale_id, null);
      const { rows } = await c.query(`SELECT user_id, metadata FROM audit_log WHERE action = 'grading.quiz.scale_set' AND entity_id = $1`, [w.quizId]);
      assert.deepEqual(rows.map((r) => [r.user_id, r.metadata]), [[pa, { scaleId: null }]]);

      // A student scale cannot grade a quiz.
      const wrong = await outcome(() => a.setQuizScaleAction(undefined, form({ quizId: w.quizId, gradingScaleId: w.studentScale })));
      assert.equal((wrong as { value: { ok: boolean } }).value.ok, false);
      assert.match((wrong as { value: { message: string } }).value.message, /grades something else/);
      // Its own scale again.
      await outcome(() => a.setQuizScaleAction(undefined, form({ quizId: w.quizId, gradingScaleId: w.scale })));
      assert.equal((await c.query(`SELECT grading_scale_id FROM quizzes WHERE id = $1`, [w.quizId])).rows[0].grading_scale_id, w.scale);

      // A teacher is turned away before anything is written.
      signIn({ id: w.learner, role: "teacher" });
      assert.deepEqual(await outcome(() => a.setQuizScaleAction(undefined, form({ quizId: w.quizId, gradingScaleId: "" }))), {
        kind: "redirect",
        location: "/forbidden",
      });
      assert.equal((await c.query(`SELECT grading_scale_id FROM quizzes WHERE id = $1`, [w.quizId])).rows[0].grading_scale_id, w.scale);
    } finally {
      await w.f.cleanup();
    }
  });
});
