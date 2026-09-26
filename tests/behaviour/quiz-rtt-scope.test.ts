// The quiz routes and the RTT subject a quiz belongs to, rendered for real.
//
// ── THE DEFECTS ──────────────────────────────────────────────────────────────
//
// W3-21. /rtt, the subject page and the open-assessment list show a viewer
// only the RTT subjects lib/rtt/scope.ts gives them: a retired subject is
// hidden from everyone but an administrator, a subject taught in one district
// or zone from teachers elsewhere. The quiz routes looked a quiz up by slug and
// checked only quizzes.active, so a direct link -- a WhatsApp share, an old
// bookmark -- still opened such a subject's quiz and recorded the attempt.
//
// W3-22. The result page told a learner who passed "you may proceed to the
// next module" and linked nowhere near it: Continue went to /dashboard, which
// does not lead to the subject either.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL runner page, submit action, history and result pages through the
// app's own @gml/db pool, for a teacher of a small committed programme
// (./_rtt-world.ts: her school is in zone Z of district D; zone Y is in
// another district). Only auth() is stubbed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { signIn, closeAppDb, outcome, type TestUser } from "./_server-actions.js";
import { renderSync, openingTags, attr, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)/quizzes/[slug]";
const text = (html: string) => decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const hrefs = (html: string) => openingTags(html, "a").map((t) => attr(t, "href") ?? "");

type AnyEl = { props: Record<string, unknown> };
function findElement(node: unknown, match: (el: AnyEl) => boolean): AnyEl | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElement(n, match);
      if (hit) return hit;
    }
  } else if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as AnyEl;
    if (match(el)) return el;
    return findElement(el.props.children, match);
  }
  return undefined;
}

/** GET /quizzes/<slug>: the runner's props, or where it went instead. */
async function openRunner(user: TestUser, slug: string, searchParams: Record<string, string> = {}) {
  signIn(user);
  const { default: Page } = await import(`${APP}/page.tsx`);
  const res = await outcome(() => Page({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(searchParams) }));
  if (res.kind !== "returned") return { res };
  const runner = findElement(res.value, (el) => typeof el.props.submitAction === "function");
  return { res, html: renderSync(res.value), runner: runner?.props as { attemptId: string } | undefined };
}

async function submit(user: TestUser, slug: string, attemptId: string, answers: unknown[]) {
  signIn(user);
  const { submitQuizAttempt } = await import(`${APP}/page.tsx`);
  return outcome(() => submitQuizAttempt(slug, attemptId, answers as never));
}

async function historyHtml(user: TestUser, slug: string) {
  signIn(user);
  const { default: History } = await import(`${APP}/history/page.tsx`);
  return renderSync(await History({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }));
}

async function resultHtml(user: TestUser, slug: string, submissionId: string) {
  signIn(user);
  const { default: Result } = await import(`${APP}/result/[submissionId]/page.tsx`);
  return renderSync(await Result({ params: Promise.resolve({ slug, submissionId }) }));
}

/** A quiz with one question on `subjectId`; returns it and its question id. */
async function quizOn(w: RttWorld, subjectId: string) {
  const quiz = await w.quiz(subjectId);
  const questionId = (
    await w.c.query(
      `INSERT INTO quiz_questions (quiz_id, sequence, prompt, options, correct_index) VALUES ($1, 1, 'P', '["a","b"]'::jsonb, 0) RETURNING id`,
      [quiz.id],
    )
  ).rows[0].id as string;
  return { ...quiz, answers: [{ questionId, selectedIndex: 0 }] };
}

const submissions = async (w: RttWorld, quizId: string) =>
  (await w.c.query(`SELECT count(*)::int AS n FROM quiz_submissions WHERE quiz_id = $1`, [quizId])).rows[0].n as number;

// ── W3-21 ────────────────────────────────────────────────────────────────────

test("W3-21: a retired subject's quiz is not served from a direct link, and a runner already open cannot submit", { skip }, async () => {
  const w = await rttWorld("w321-ret");
  try {
    const subject = await w.subject({ name: `Retiring ${w.T}` });
    const quiz = await quizOn(w, subject);
    // Taken once while the subject was live, and open again in a tab.
    const first = await openRunner(w.teacher, quiz.slug);
    const taken = await submit(w.teacher, quiz.slug, first.runner!.attemptId, quiz.answers);
    const earlier = (taken as { location?: string }).location?.match(/\/result\/([0-9a-f-]{36})$/)?.[1];
    assert.ok(earlier, `the live quiz was not scored: ${JSON.stringify(taken)}`);
    const tab = await openRunner(w.teacher, quiz.slug);
    assert.ok(tab.runner, "a live subject's quiz is served");

    await w.c.query(`UPDATE rtt_subjects SET active = false WHERE id = $1`, [subject]);

    assert.equal((await openRunner(w.teacher, quiz.slug)).res.kind, "notFound", "the runner was served from a direct link");
    const late = await submit(w.teacher, quiz.slug, tab.runner!.attemptId, quiz.answers);
    assert.deepEqual(late, { kind: "redirect", location: `/quizzes/${quiz.slug}?error=not_found` });
    assert.match(text((await openRunner(w.teacher, quiz.slug, { error: "not_found" })).html ?? ""), /That quiz is no longer available/);
    assert.equal(await submissions(w, quiz.id), 1, "a submission was recorded on a retired subject");

    // Her own results stay readable; nothing offers to start the quiz again.
    const history = await historyHtml(w.teacher, quiz.slug);
    assert.match(history, /data-testid="quiz-history-row"/);
    assert.doesNotMatch(text(history), /Take quiz again|Start the quiz/, "history offers a retake of a retired subject's quiz");
    assert.doesNotMatch(text(await resultHtml(w.teacher, quiz.slug, earlier!)), /Retake/, "the result page offers a retake");

    // An administrator, who may re-activate the subject, still reaches it.
    assert.ok((await openRunner(w.admin, quiz.slug)).runner, "an administrator could not open a retired subject's quiz");
  } finally {
    await w.cleanup();
  }
});

test("W3-21: a quiz of a subject taught in another district's zone is not served, nor scored on a direct POST", { skip }, async () => {
  const w = await rttWorld("w321-zone");
  try {
    const elsewhere = await quizOn(w, await w.subject({ name: `ZoneY ${w.T}`, zoneId: w.zoneYId }));
    const here = await quizOn(w, await w.subject({ name: `ZoneZ ${w.T}`, zoneId: w.zoneId }));
    assert.ok((await openRunner(w.teacher, here.slug)).runner, "her own zone's quiz is served");
    assert.equal((await openRunner(w.teacher, elsewhere.slug)).res.kind, "notFound", "another zone's quiz was served");
    const posted = await submit(w.teacher, elsewhere.slug, randomUUID(), elsewhere.answers);
    assert.deepEqual(posted, { kind: "redirect", location: `/quizzes/${elsewhere.slug}?error=not_found` });
    assert.equal(await submissions(w, elsewhere.id), 0);
    // Staff see the whole programme.
    assert.ok((await openRunner(w.admin, elsewhere.slug)).runner, "an administrator could not open another zone's quiz");
  } finally {
    await w.cleanup();
  }
});

// ── W3-22 ────────────────────────────────────────────────────────────────────

test("W3-22: a passed RTT quiz's result leads back to its subject, where the next module is", { skip }, async () => {
  const w = await rttWorld("w322-rtt");
  try {
    const subject = await w.subject({ name: `Subject ${w.T}` });
    const quiz = await quizOn(w, subject);
    const passed = await w.submission(quiz.id, w.teacher.id, 100, true);
    const html = await resultHtml(w.teacher, quiz.slug, passed);
    assert.ok(hrefs(html).includes(`/rtt/subject/${subject}`), `no way back to the subject: ${JSON.stringify(hrefs(html))}`);
    assert.match(text(html), /next module/);

    // Once the subject is retired its page is not there to go back to.
    await w.c.query(`UPDATE rtt_subjects SET active = false WHERE id = $1`, [subject]);
    const retired = await resultHtml(w.teacher, quiz.slug, passed);
    assert.ok(!hrefs(retired).includes(`/rtt/subject/${subject}`), "a link to a subject page that 404s");
    assert.doesNotMatch(text(retired), /next module/, "the next module is promised with nowhere to find it");
    assert.ok(hrefs(retired).includes("/dashboard"));
  } finally {
    await w.cleanup();
  }
});

test("W3-22: a passed quiz on a curriculum subject promises no module and continues to the dashboard", { skip }, async () => {
  const w = await rttWorld("w322-cur");
  const curric = (
    await w.c.query(`INSERT INTO subjects (name, code) VALUES ($1, $2) RETURNING id`, [`Curric ${w.T}`, w.T.slice(-20)])
  ).rows[0].id as string;
  const slug = `cur-${w.T}`.toLowerCase();
  try {
    const quizId = (
      await w.c.query(`INSERT INTO quizzes (slug, title, subject_id, active) VALUES ($1, 'Curriculum quiz', $2, true) RETURNING id`, [
        slug,
        curric,
      ])
    ).rows[0].id as string;
    const passed = await w.submission(quizId, w.teacher.id, 100, true);
    const html = await resultHtml(w.teacher, slug, passed);
    assert.doesNotMatch(text(html), /next module/, "a quiz outside RTT has no module to proceed to");
    assert.ok(hrefs(html).includes("/dashboard"));
    assert.ok(!hrefs(html).some((h) => h.startsWith("/rtt/subject/")));
  } finally {
    await w.c.query(`DELETE FROM quizzes WHERE slug = $1`, [slug]);
    await w.c.query(`DELETE FROM subjects WHERE id = $1`, [curric]);
    await w.cleanup();
  }
});
