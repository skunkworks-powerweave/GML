// The RTT and quiz pages lay out at PHONE width -- executed on their real
// markup, with real content in them.
//
// ── THE DEFECT (F11) ─────────────────────────────────────────────────────────
//
// The phone shell renders the same page JSX as the desktop shell. The RTT
// subject page set its two columns as an inline gridTemplateColumns
// "1.5fr 1fr", which holds at every width (no stylesheet can override an
// inline style), and its left column -- modules, and the cohort sessions table
// with nowhere to scroll -- was as wide as that table. At 360 px the page was
// ~580 px wide: the right column, holding Required readings and the
// Assessment card with the quiz's Start button, was laid out off the right
// edge of the screen, Join was clipped, and Chrome widened the layout
// viewport so the fixed bottom tab bar went off screen too. The two things a
// teacher opens a subject for could not be seen without panning sideways.
// With no modules and no sessions (the seed) the page fitted, which is why
// only a page WITH content shows it.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// Each REAL page is rendered as a phone user (gml-device=mobile) against
// Postgres, and ./_phone-layout.ts resolves every element's layout at 360 px
// from its inline style, globals.css and the app's own Tailwind build (its
// rules are checked against known markup in ui-phone-layout.test.ts).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, request, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";
import { phoneLayoutIssues, templateAt, PHONE_WIDTH } from "./_phone-layout.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)";
const DAY = 86_400_000;

async function asPhone(user: TestUser, page: () => Promise<unknown>): Promise<string> {
  signIn(user);
  request.cookies = { "gml-device": "mobile" };
  try {
    return await render(withAppRouter(await page()));
  } finally {
    request.cookies = {};
  }
}

function noIssues(issues: string[], where: string) {
  assert.deepEqual(issues, [], `${where} at ${PHONE_WIDTH}px:\n  ${issues.join("\n  ")}`);
}

// What a reader sees: React's <!-- --> text-node separators are not text, and
// every tag boundary is.
const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/**
 * Track count of a resolved template: "minmax(0,1.5fr) minmax(0,1fr)" -> 2,
 * "repeat(1, minmax(0, 1fr))" -> 1.
 */
function columns(template: string): number {
  const tokens: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of `${template} `) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (buf) tokens.push(buf);
      buf = "";
    } else buf += ch;
  }
  let n = 0;
  for (const t of tokens) {
    const rep = t.match(/^repeat\((\d+),\s*(.*)\)$/);
    n += rep ? Number(rep[1]) * columns(rep[2]!) : 1;
  }
  return n;
}

/**
 * A subject with everything its page can show: modules (one with lessons and a
 * long description), an upcoming session with a link and a past one without,
 * the teacher's attendance, a reading, and a quiz she has passed.
 */
async function fullSubject(w: RttWorld): Promise<string> {
  const subjectId = await w.subject({ name: `Foundational literacy and numeracy ${w.T}` });
  const m1 = await w.module(subjectId, 1, `Reading readiness in multilingual classrooms ${w.T}`);
  await w.c.query(`UPDATE rtt_modules SET description = $2 WHERE id = $1`, [
    m1,
    "Phonemic awareness, print concepts and oral language, for learners whose home language is not the language of the classroom.",
  ]);
  await w.lesson(m1, 1);
  await w.lesson(m1, 2);
  await w.module(subjectId, 2);
  await w.reading(subjectId, 1, `NCERT foundational stage guidelines ${w.T}`);
  const upcoming = await w.session(subjectId, {
    sequence: 1,
    title: `Webinar: running a reading circle with forty learners ${w.T}`,
    link: "https://meet.example.test/abc-defg-hij",
    scheduledAt: new Date(Date.now() + 3 * DAY),
  });
  await w.session(subjectId, { sequence: 2, scheduledAt: new Date(Date.now() - 3 * DAY) });
  await w.c.query(`INSERT INTO rtt_attendance (rtt_session_id, teacher_id, status) VALUES ($1, $2, 'present')`, [
    upcoming,
    w.teacherId,
  ]);
  const quiz = await w.quiz(subjectId, { title: `Mid-unit check ${w.T}` });
  await w.submission(quiz.id, w.teacher.id, 80, true);
  await w.quiz(subjectId, { title: `Endline ${w.T}` });
  return subjectId;
}

// ── /rtt/subject/[id] ────────────────────────────────────────────────────────

test("an RTT subject page with content fits a phone: readings and the assessment are in the column, the sessions table scrolls in its card; the desktop keeps two columns", { skip }, async () => {
  const w = await rttWorld("phonesubj");
  try {
    const subjectId = await fullSubject(w);
    const { default: SubjectPage } = await import(`${APP}/rtt/subject/[id]/page.tsx`);
    const html = await asPhone(w.teacher, () =>
      SubjectPage({ params: Promise.resolve({ id: subjectId }), searchParams: Promise.resolve({}) }),
    );
    // The content that overflowed is on the page.
    const shown = text(html);
    assert.ok(shown.includes("Required readings (1)"), "the readings card is on the page");
    assert.ok(shown.includes(" Start "), "the unattempted quiz offers Start");
    assert.ok(shown.includes(" Join "), "the upcoming session offers Join");
    noIssues(await phoneLayoutIssues(html), "/rtt/subject/[id]");

    // The desktop layout is unchanged: modules and sessions beside readings
    // and the assessment.
    const desktop = await templateAt(html, 1280, (e) => e.tag === "section" && /md:grid-cols/.test(e.attrs.class ?? ""));
    assert.ok(desktop.some((t) => columns(t) === 2), `two columns on a desktop: ${desktop.join(" | ")}`);
  } finally {
    await w.cleanup();
  }
});

// ── the rest of RTT ──────────────────────────────────────────────────────────

const P = <T,>(v: T) => Promise.resolve(v);

test("/rtt, /rtt/progress and the online hub fit a phone, for a teacher and for an administrator", { skip }, async () => {
  const w = await rttWorld("phonerttx");
  try {
    const subjectId = await fullSubject(w);
    // Next week's Wednesday, 10:00: a weekday inside the calendar's three
    // weeks whatever day this runs, so the calendar and the upcoming list
    // both have the row.
    const wednesday = new Date();
    wednesday.setHours(10, 0, 0, 0);
    wednesday.setDate(wednesday.getDate() - ((wednesday.getDay() + 6) % 7) + 9);
    await w.session(subjectId, { sequence: 3, title: `Live quiz ${w.T}`, scheduledAt: wednesday });
    const { default: Index } = await import(`${APP}/rtt/page.tsx`);
    const { default: Progress } = await import(`${APP}/rtt/progress/page.tsx`);
    const { default: Sync } = await import(`${APP}/rtt/online/synchronous/page.tsx`);
    const { default: Async } = await import(`${APP}/rtt/online/asynchronous/page.tsx`);
    const pages: Array<[string, TestUser, () => Promise<unknown>]> = [
      ["/rtt", w.teacher, () => Index({ searchParams: P({}) })],
      ["/rtt?district=", w.admin, () => Index({ searchParams: P({ district: w.districtId }) })],
      ["/rtt/progress", w.teacher, () => Progress({ searchParams: P({}) })],
      ["/rtt/progress?district=", w.admin, () => Progress({ searchParams: P({ district: w.districtId }) })],
      ["/rtt/online/synchronous", w.teacher, () => Sync()],
      ["/rtt/online/asynchronous", w.teacher, () => Async({ searchParams: P({}) })],
    ];
    const failures: string[] = [];
    const rendered = new Map<string, string>();
    for (const [route, user, run] of pages) {
      const html = await asPhone(user, run);
      rendered.set(route, html);
      for (const issue of await phoneLayoutIssues(html)) failures.push(`${route}: ${issue}`);
    }
    noIssues(failures, "RTT pages");

    // The webinar calendar: five day columns (and the week label) on a
    // desktop, a single list on a phone -- where only the days with a session
    // are shown, each naming its weekday.
    const sync = rendered.get("/rtt/online/synchronous")!;
    assert.ok(text(sync).includes(`Live quiz ${w.T}`), "the session is on the calendar");
    const calendar = (e: { attrs: Record<string, string> }) => /md:grid-cols-\[60px/.test(e.attrs.class ?? "");
    assert.deepEqual((await templateAt(sync, PHONE_WIDTH, calendar)).map(columns), [1], "the calendar is one column on a phone");
    assert.deepEqual((await templateAt(sync, 1280, calendar)).map(columns), [6], "a label and five days on a desktop");
    const days = [...sync.matchAll(/<div class="(hidden md:flex md:flex-col|flex flex-col)"/g)].map((m) => m[1]);
    assert.equal(days.length, 15, "three weeks of five days are rendered");
    assert.ok(days.filter((c) => c === "flex flex-col").length >= 1, "the day with the session shows on a phone");
    assert.ok(days.filter((c) => c !== "flex flex-col").length >= 10, "empty days are hidden on a phone");
  } finally {
    await w.cleanup();
  }
});

test("the teach-back queue fits a phone, with a submission open beside the list", { skip }, async () => {
  const w = await rttWorld("phonetb");
  const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
  const fileId = await one(
    `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id)
     VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2) RETURNING id`,
    [`test/${w.T}/original.mp4`, w.teacher.id],
  );
  try {
    const clip = await one(
      `INSERT INTO video_submissions
         (file_id, source, status, context_type, submitted_by_user_id, caption_raw, hls_master_key, verified_at)
       VALUES ($1, 'direct', 'ready', 'teach_back', $2, $3, 'hls/test/index.m3u8', now()) RETURNING id`,
      [fileId, w.teacher.id, `Teach-back on place value ${w.T}`],
    );
    const { default: Queue } = await import(`${APP}/rtt/teach-back/page.tsx`);
    const failures: string[] = [];
    for (const sp of [{ status: "review_pending" }, { status: "review_pending", id: clip }]) {
      const html = await asPhone(w.mentor, () => Queue({ searchParams: P(sp) }));
      assert.ok(html.includes(`id=${clip}`), "the clip is in the list");
      const route = `/rtt/teach-back${"id" in sp ? " (one open)" : ""}`;
      for (const issue of await phoneLayoutIssues(html)) failures.push(`${route}: ${issue}`);
      if ("id" in sp) {
        // Two shrinkable columns pass the rules above, but at 360 px they were
        // a ~120 px list beside a ~180 px pane: the pane goes under the list.
        const pick = (e: { tag: string; attrs: Record<string, string> }) => e.tag === "section" && /md:grid-cols/.test(e.attrs.class ?? "");
        assert.deepEqual((await templateAt(html, PHONE_WIDTH, pick)).map(columns), [1], "one column on a phone");
        assert.deepEqual((await templateAt(html, 1280, pick)).map(columns), [2], "list and pane side by side on a desktop");
      }
    }
    noIssues(failures, "the teach-back queue");
  } finally {
    await w.c.query(`DELETE FROM video_submissions WHERE file_id = $1`, [fileId]);
    await w.c.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    await w.cleanup();
  }
});

// ── quizzes ──────────────────────────────────────────────────────────────────

test("a quiz, its history and a result fit a phone", { skip }, async () => {
  const w = await rttWorld("phonequiz");
  try {
    const subjectId = await w.subject();
    const quiz = await w.quiz(subjectId, { title: `Place value and the number line ${w.T}`, maxAttempts: 3 });
    for (let n = 1; n <= 2; n++) {
      await w.c.query(
        `INSERT INTO quiz_questions (quiz_id, sequence, prompt, options, correct_index, explanation) VALUES ($1, $2, $3, $4, 0, $5)`,
        [quiz.id, n, `Which number is ten more than ${n}4?`, JSON.stringify([`${n + 1}4`, `${n}5`, `${n}3`, "None of these"]), "Ten more moves one place up."],
      );
    }
    const passed = await w.submission(quiz.id, w.teacher.id, 100, true);
    await w.submission(quiz.id, w.teacher.id, 50, false);
    const { default: Runner } = await import(`${APP}/quizzes/[slug]/page.tsx`);
    const { default: History } = await import(`${APP}/quizzes/[slug]/history/page.tsx`);
    const { default: Result } = await import(`${APP}/quizzes/[slug]/result/[submissionId]/page.tsx`);
    const pages: Array<[string, () => Promise<unknown>]> = [
      ["/quizzes/[slug]", () => Runner({ params: P({ slug: quiz.slug }), searchParams: P({}) })],
      ["/quizzes/[slug]/history", () => History({ params: P({ slug: quiz.slug }), searchParams: P({}) })],
      ["/quizzes/[slug]/result/[id]", () => Result({ params: P({ slug: quiz.slug, submissionId: passed }) })],
    ];
    const failures: string[] = [];
    for (const [route, run] of pages) {
      const html = await asPhone(w.teacher, run);
      if (route.endsWith("/history")) {
        assert.ok(html.includes(`href="/quizzes/${quiz.slug}/result/${passed}"`), "the history lists the attempt");
      }
      for (const issue of await phoneLayoutIssues(html)) failures.push(`${route}: ${issue}`);
    }
    noIssues(failures, "quiz pages");
  } finally {
    await w.c.query(`DELETE FROM quiz_attempts WHERE user_id = $1`, [w.teacher.id]);
    await w.cleanup();
  }
});
