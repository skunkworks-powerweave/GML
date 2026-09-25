// Which quizzes an RTT subject offers, rendered for real.
//
// ── THE DEFECT (F33) ─────────────────────────────────────────────────────────
//
// quizzes.slug is unique programme-wide and every quiz is bound to exactly one
// RTT subject (quizzes_one_scope). The subject page nevertheless looked its
// assessments up by the two fixed slugs "mid-unit" and "endline", with no
// subject predicate, and linked /quizzes/mid-unit?subjectId=<id> -- a hint the
// runner never read. So one "mid-unit" quiz stood in for every subject in every
// phase (a maths quiz ran as the Reading comprehension check), and a quiz bound
// to a subject under any other slug was listed nowhere a learner could reach.
// The dashboard's "N open quizzes" to-do linked to /rtt, which listed no
// quizzes at all, and counted quizzes no learner page offers.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL pages, through the app's own @gml/db pool, signed in as a teacher of
// a small committed programme (./_rtt-world.ts). Only auth() is stubbed. The
// helpers the pages and the dashboard share are also run directly, on one
// REPEATABLE READ snapshot, so the count and the list can be compared exactly
// while other test files commit quizzes of their own.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, openingTags, attr, decodeEntities } from "./_ui.js";
import { needsDatabase, withClient } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(closeAppDb);

const subjectPage = () => import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
const hubPage = () => import("../../apps/web/src/app/(authenticated)/rtt/page.tsx");
const assessments = () => import("../../apps/web/src/lib/rtt/assessments.ts");

/** Every href on the page that opens a quiz. */
const quizHrefs = (html: string) =>
  openingTags(html, "a")
    .map((t) => attr(t, "href") ?? "")
    .filter((h) => h.startsWith("/quizzes/"));

// What a reader sees: React's <!-- --> text-node separators are not text, and
// every tag boundary is.
const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

async function renderSubject(user: TestUser, id: string): Promise<string> {
  signIn(user);
  const { default: RttSubjectPage } = await subjectPage();
  return render(
    withAppRouter(await RttSubjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })),
  );
}

async function renderHub(user: TestUser, sp: Record<string, string> = {}): Promise<string> {
  signIn(user);
  const { default: RttIndexPage } = await hubPage();
  return render(withAppRouter(await RttIndexPage({ searchParams: Promise.resolve(sp) })));
}

test("F33: a subject page offers the quizzes bound to that subject, and only those", { skip }, async () => {
  const w = await rttWorld("f33-subject");
  let ownMidUnit: string | null = null;
  try {
    const a = await w.subject();
    const b = await w.subject();
    // The reproduction's own slug. Created only if no other row holds it; B is
    // brand new, so whichever row does hold it is not bound to B.
    const mid = await w.c.query(
      `INSERT INTO quizzes (slug, title, rtt_subject_id, active) VALUES ('mid-unit', $1, $2, true)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [`Mid-unit ${w.T}`, a],
    );
    ownMidUnit = (mid.rows[0]?.id as string | undefined) ?? null;
    const unit2 = await w.quiz(b, { title: `Unit 2 check ${w.T}` });
    const retired = await w.quiz(b, { title: `Retired ${w.T}`, active: false });

    const pageB = await renderSubject(w.teacher, b);
    const hrefsB = quizHrefs(pageB);
    assert.ok(
      hrefsB.includes(`/quizzes/${unit2.slug}`),
      `subject B must offer its own quiz ${unit2.slug}; the page linked ${JSON.stringify(hrefsB)}`,
    );
    assert.ok(
      !hrefsB.some((h) => h.startsWith("/quizzes/mid-unit")),
      `subject B must not run another subject's mid-unit quiz; it linked ${JSON.stringify(hrefsB)}`,
    );
    assert.ok(!hrefsB.some((h) => h.includes(retired.slug)), "an inactive quiz is not offered");
    assert.ok(!text(pageB).includes(`Retired ${w.T}`), "nor named");

    if (ownMidUnit) {
      const pageA = await renderSubject(w.teacher, a);
      const hrefsA = quizHrefs(pageA);
      assert.ok(hrefsA.includes("/quizzes/mid-unit"), `A offers the quiz bound to it: ${JSON.stringify(hrefsA)}`);
      assert.ok(!hrefsA.some((h) => h.includes(unit2.slug)), "and not B's");
      assert.ok(!hrefsA.some((h) => h.includes("subjectId=")), "no parameter the runner ignores");
    }
  } finally {
    if (ownMidUnit) await w.c.query(`DELETE FROM quizzes WHERE id = $1`, [ownMidUnit]);
    await w.cleanup();
  }
});

test("F33: a subject's quiz row shows the learner's own best result, and a spent cap links the results", { skip }, async () => {
  const w = await rttWorld("f33-result");
  try {
    const s = await w.subject();
    const open = await w.quiz(s, { title: `Open check ${w.T}` });
    const capped = await w.quiz(s, { title: `Capped check ${w.T}`, maxAttempts: 2 });
    await w.submission(open.id, w.teacher.id, 40, false);
    await w.submission(open.id, w.teacher.id, 80, true);
    await w.submission(capped.id, w.teacher.id, 30, false);
    await w.submission(capped.id, w.teacher.id, 50, false);
    // Someone else's result is not hers.
    const other = await w.user("Other", "teacher");
    await w.submission(capped.id, other.id, 100, true);

    const page = await renderSubject(w.teacher, s);
    const t = text(page);
    const row = (title: string) => {
      const at = t.indexOf(title);
      assert.ok(at >= 0, `row for ${title}`);
      return t.slice(at, at + 160);
    };
    assert.match(row(`Open check ${w.T}`), /Best 80%/, "her best score, not her last");
    assert.match(row(`Open check ${w.T}`), /Passed/);
    assert.match(row(`Capped check ${w.T}`), /Best 50%/, "another learner's 100% is not hers");
    assert.doesNotMatch(row(`Capped check ${w.T}`), /Passed/);

    const hrefs = quizHrefs(page);
    assert.ok(hrefs.includes(`/quizzes/${open.slug}`), "attempts left: the runner");
    assert.ok(
      hrefs.includes(`/quizzes/${capped.slug}/history`),
      `no attempts left: her results, not a runner that refuses her (${JSON.stringify(hrefs)})`,
    );
    assert.ok(!hrefs.includes(`/quizzes/${capped.slug}`));
  } finally {
    await w.cleanup();
  }
});

test("F33: /rtt -- where the dashboard's open-quiz to-do lands -- lists the viewer's open quizzes", { skip }, async () => {
  const w = await rttWorld("f33-hub");
  try {
    const s = await w.subject();
    const todo = await w.quiz(s, { title: `To do ${w.T}` });
    const done = await w.quiz(s, { title: `Done ${w.T}` });
    const hidden = await w.quiz(s, { title: `Draft ${w.T}`, active: false });
    await w.submission(done.id, w.teacher.id, 90, true);

    const hrefs = quizHrefs(await renderHub(w.teacher));
    assert.ok(hrefs.includes(`/quizzes/${todo.slug}`), `the open quiz is linked from /rtt: ${JSON.stringify(hrefs)}`);
    assert.ok(!hrefs.includes(`/quizzes/${done.slug}`), "a quiz she has taken is not open");
    assert.ok(!hrefs.includes(`/quizzes/${hidden.slug}`), "an inactive quiz is not offered");

    // It is a learner's list. Staff take no RTT quizzes, and for them it was
    // every active quiz in the programme under "you have not taken yet".
    for (const staff of [w.admin, w.mentor, w.observer]) {
      const html = await renderHub(staff);
      assert.ok(!text(html).includes("Open assessments"), `${staff.role}: no learner's to-do list`);
    }
  } finally {
    await w.cleanup();
  }
});

test("F33: the open-quiz count is the list /rtt shows, and leaves out quizzes no learner page offers", { skip }, async () => {
  const { listOpenAssessments, countOpenAssessments } = await assessments();
  const w = await rttWorld("f33-count");
  const curriculum = await w.c.query(
    `INSERT INTO subjects (name, code) VALUES ($1, $2) RETURNING id`,
    [`Curriculum ${w.T}`, w.T.slice(-24)],
  );
  const curriculumId = curriculum.rows[0].id as string;
  try {
    const s = await w.subject();
    const reachable = await w.quiz(s);
    const unreachable = await w.c.query(
      `INSERT INTO quizzes (slug, title, subject_id, active) VALUES ($1, $2, $3, true) RETURNING id`,
      [`cur-${w.T}`.toLowerCase(), `Curriculum quiz ${w.T}`, curriculumId],
    );
    const viewer = { id: w.teacher.id, role: "teacher" };
    await withClient(async (c) => {
      // One snapshot for both reads, so concurrent files cannot move the count.
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      try {
        const db = drizzle(c);
        const list = await listOpenAssessments(db, viewer);
        const n = await countOpenAssessments(db, viewer);
        const ids = list.map((q) => q.id);
        assert.ok(ids.includes(reachable.id), "the subject-bound quiz is open");
        assert.ok(!ids.includes(unreachable.rows[0].id), "a curriculum-bound quiz has no learner page");
        assert.equal(n, list.length, "the dashboard's number is the length of the list it links to");
      } finally {
        await c.query("ROLLBACK");
      }
    });
  } finally {
    await w.c.query(`DELETE FROM quizzes WHERE subject_id = $1`, [curriculumId]);
    await w.c.query(`DELETE FROM subjects WHERE id = $1`, [curriculumId]);
    await w.cleanup();
  }
});
