// RTT, quizzes and SCORM speak the language the user picked (UAT, 2026-09-27).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Choosing Hindi or Bhoti translated the menu and nothing else: /rtt, a
// subject's page, the progress tables, the webinar calendar, the teach-back
// queue, the quiz runner, its history and result pages and the SCORM player
// all stayed English, down to the dates ("27 Sept") and the quiz countdown's
// spoken warnings. Their copy now comes from the rtt namespace
// (apps/web/src/i18n/locales/<locale>/rtt.json).
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL pages and components, rendered through next-intl's real provider
// and translator for the fake request's locale (./_ui.ts): the client
// components with mount(..., { intl }) and renderSync, the server pages
// against a small committed programme (./_rtt-world.ts). Each check finds a
// string of the rtt namespace in the chosen language AND the absence of its
// English original, so a page that fell back to English fails.

import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { h, mount, render, renderSync, request, withAppRouter, hostElements, textOf, decodeEntities, SRC_DIR } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});
afterEach(() => {
  request.locale = "en";
});

type Locale = "en" | "hi" | "bo";
type Tree = { [k: string]: string | Tree };
const bundle = (locale: Locale): Tree =>
  JSON.parse(readFileSync(join(SRC_DIR, "i18n", "locales", locale, "rtt.json"), "utf8")) as Tree;
/** rtt.<path> in `locale`, as the bundle has it (arguments unfilled). */
function msg(locale: Locale, path: string): string {
  const v = path.split(".").reduce<string | Tree | undefined>((n, k) => (n && typeof n === "object" ? n[k] : undefined), bundle(locale));
  assert.equal(typeof v, "string", `rtt.${path} exists in ${locale}`);
  return v as string;
}

// What a reader sees: React's <!-- --> separators are not text, tags are gaps.
const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** `seen` shows rtt.<path> in `locale` and not in English. */
function translated(seen: string, locale: Locale, path: string, label: string): void {
  const local = msg(locale, path);
  const english = msg("en", path);
  assert.notEqual(local, english, `rtt.${path} is translated into ${locale}`);
  assert.ok(seen.includes(local), `${label} (${locale}): shows ${JSON.stringify(local)}`);
  assert.ok(!seen.includes(english), `${label} (${locale}): no English ${JSON.stringify(english)}`);
}

const APP = "../../apps/web/src/app/(authenticated)";
const QUESTIONS = [{ id: "q1", prompt: "Which is a vowel?", options: ["Apple", "Bat"] }];

// ── client components ────────────────────────────────────────────────────────

test("the quiz runners (desktop and phone) are in Hindi and Bhoti, down to the spoken time-up warning", async () => {
  const { QuizRunner } = await import("../../apps/web/src/components/quiz/QuizRunner.tsx");
  const { MobileQuizRunner } = await import("../../apps/web/src/components/quiz/MobileQuizRunner.tsx");
  for (const locale of ["hi", "bo"] as const) {
    request.locale = locale;
    for (const [name, Runner] of [["QuizRunner", QuizRunner], ["MobileQuizRunner", MobileQuizRunner]] as const) {
      // No time left and nothing chosen: the runner says so, and its polite
      // region says "Time is up. Nothing was submitted." -- in her language.
      const html = text(renderSync(h(Runner as never, { slug: "s", title: "T", questions: QUESTIONS, timeLimitSeconds: 0, attemptId: "", submitAction: async () => undefined } as never)));
      translated(html, locale, "client.quizRunner.timeRemaining", name);
      translated(html, locale, "client.quizRunner.ranOut", name);
      translated(html, locale, "client.quizRunner.timeWarning.timeUpNothingSent", name);
      translated(html, locale, name === "QuizRunner" ? "client.quizRunner.submitAnswers" : "client.quizRunner.submit", name);
      assert.ok(html.includes(msg(locale, "client.quizRunner.question").replace("{number}", "1")), `${name} (${locale}): "Question 1"`);
      // The quiz's own words are data: shown as the author wrote them.
      assert.ok(html.includes("Which is a vowel?") && html.includes("Apple"), `${name}: the question is shown as stored`);
    }
    // The phone's progress dots are named in her language too.
    const m = mount(MobileQuizRunner as never, { slug: "s", title: "T", questions: QUESTIONS, submitAction: async () => undefined } as never, { intl: locale });
    const labels = hostElements(m.tree).map((el) => el.props["aria-label"]).filter(Boolean);
    assert.ok(labels.includes(msg(locale, "client.quizRunner.dotCurrent").replace("{number}", "1")), `dots (${locale}): ${JSON.stringify(labels)}`);
    assert.ok(!labels.includes("Current question 1"), `dots (${locale}): not English`);
  }
});

test("the SCORM player's notices are in Bhoti and Hindi", async () => {
  const { ScormPlayer } = await import(`${APP}/scorm/[id]/player.tsx`);
  const init = {
    studentId: "u",
    studentName: "Learner",
    lessonStatus: "not attempted",
    lessonLocation: "",
    scoreRaw: null,
    scoreMin: null,
    scoreMax: null,
    suspendData: "",
    totalTimeCs: 0,
    entry: "ab-initio",
    launchData: null,
    masteryScore: null,
  };
  for (const locale of ["bo", "hi"] as const) {
    const m = mount(ScormPlayer as never, { packageId: "p", src: "/x", title: "T", backHref: "/rtt/subject/s", init } as never, { intl: locale });
    // The <noscript> line is always there; the others follow the commits.
    translated(textOf(m.tree), locale, "client.scormPlayer.noscript", "player");
  }
});

// ── server pages ─────────────────────────────────────────────────────────────

async function page(user: TestUser, locale: Locale, run: () => Promise<unknown>): Promise<string> {
  signIn(user);
  request.locale = locale;
  return text(await render(withAppRouter(await run())));
}

test("/rtt, a subject's page and /rtt/progress are in Hindi and Bhoti, dates included", { skip }, async () => {
  const w = await rttWorld("i18nrtt");
  try {
    const subjectId = await w.subject();
    const moduleId = await w.module(subjectId, 1, `Module ${w.T}`);
    await w.lesson(moduleId, 1, `Lesson ${w.T}`);
    await w.reading(subjectId, 1, `Reading ${w.T}`);
    await w.session(subjectId, { sequence: 1, title: `Webinar ${w.T}`, scheduledAt: new Date("2026-09-27T05:30:00Z") });
    await w.quiz(subjectId, { title: `Quiz ${w.T}`, maxAttempts: 2 });
    const { default: Hub } = await import(`${APP}/rtt/page.tsx`);
    const { default: Subject } = await import(`${APP}/rtt/subject/[id]/page.tsx`);
    const { default: Progress } = await import(`${APP}/rtt/progress/page.tsx`);

    for (const locale of ["hi", "bo"] as const) {
      const hub = await page(w.teacher, locale, () => Hub({ searchParams: Promise.resolve({}) }));
      translated(hub, locale, "hub.programmeName", "/rtt");
      translated(hub, locale, "hub.title", "/rtt");
      translated(hub, locale, "hub.openAssessmentsHint", "/rtt");

      const subject = await page(w.teacher, locale, () =>
        Subject({ params: Promise.resolve({ id: subjectId }), searchParams: Promise.resolve({}) }),
      );
      translated(subject, locale, "subject.resume", "subject page");
      translated(subject, locale, "subject.assessment", "subject page");
      translated(subject, locale, "subject.yourProgress", "subject page");
      translated(subject, locale, "subject.teachBackIntro", "subject page");
      translated(subject, locale, "subject.markDone", "subject page");
      // The session's date is written in her language, not "27 Sept 2026".
      assert.ok(!/Sept/.test(subject), `subject page (${locale}): the session date is not in English`);
      // Data stays data: the titles are shown as entered.
      assert.ok(subject.includes(`Module ${w.T}`) && subject.includes(`Webinar ${w.T}`), "titles as stored");

      const progress = await page(w.teacher, locale, () => Progress({ searchParams: Promise.resolve({}) }));
      translated(progress, locale, "progress.myTitle", "/rtt/progress");
      translated(progress, locale, "progress.footnote", "/rtt/progress");
      translated(progress, locale, "progress.col.readings", "/rtt/progress");
    }

    // An administrator's staff view of the same, in Bhoti.
    const staff = await page(w.admin, "bo", () => Progress({ searchParams: Promise.resolve({}) }));
    translated(staff, "bo", "progress.staffTitle", "/rtt/progress (staff)");
    translated(staff, "bo", "progress.quizResults", "/rtt/progress (staff)");
    translated(staff, "bo", "placePicker.whole", "/rtt/progress (staff)");
  } finally {
    await w.cleanup();
  }
});

test("a quiz's history and result pages are in Hindi and Bhoti", { skip }, async () => {
  const w = await rttWorld("i18nquiz");
  try {
    const subjectId = await w.subject();
    const quiz = await w.quiz(subjectId, { title: `Quiz ${w.T}`, maxAttempts: 3 });
    const submissionId = await w.submission(quiz.id, w.teacher.id, 40, false);
    const { default: History } = await import(`${APP}/quizzes/[slug]/history/page.tsx`);
    const { default: Result } = await import(`${APP}/quizzes/[slug]/result/[submissionId]/page.tsx`);
    for (const locale of ["hi", "bo"] as const) {
      signIn(w.teacher);
      request.locale = locale;
      const history = text(
        renderSync(await History({ params: Promise.resolve({ slug: quiz.slug }), searchParams: Promise.resolve({ error: "attempt_closed" }) })),
      );
      translated(history, locale, "history.title", "history");
      translated(history, locale, "history.errors.attemptClosed", "history");
      translated(history, locale, "history.viewResult", "history");
      translated(history, locale, "history.backToDashboard", "history");

      const result = text(renderSync(await Result({ params: Promise.resolve({ slug: quiz.slug, submissionId }) })));
      translated(result, locale, "result.title", "result");
      translated(result, locale, "result.viewHistory", "result");
      assert.ok(!/Your wrong answers are marked below/.test(result), `result (${locale}): not English`);
    }
    // The page title a browser tab shows, in the viewer's language.
    request.locale = "bo";
    const { generateMetadata } = await import(`${APP}/quizzes/[slug]/history/page.tsx`);
    assert.equal((await generateMetadata()).title, msg("bo", "history.metaTitle"));
  } finally {
    await w.c.query(`DELETE FROM quiz_attempts WHERE user_id = $1`, [w.teacher.id]);
    await w.cleanup();
  }
});

test("the SCORM status words the pages share are the viewer's language (lib/scorm/format.ts)", async () => {
  const { statusLabel, launchLabel, formatDuration } = await import("../../apps/web/src/lib/scorm/format.ts");
  const { getTranslations } = await import("next-intl/server");
  request.locale = "hi";
  const t = (await getTranslations("rtt")) as unknown as (key: string, values?: Record<string, string | number>) => string;
  assert.equal(statusLabel("incomplete", t), msg("hi", "scorm.status.incomplete"));
  assert.equal(launchLabel("not attempted", t), msg("hi", "scorm.launch.start"));
  assert.equal(formatDuration(1500, t), msg("hi", "scorm.duration.seconds").replace("{seconds}", "15"));
  // A page that passes no translator still reads as before, in English.
  assert.equal(statusLabel("incomplete"), "In progress");
  assert.equal(formatDuration(5 * 60 * 100 + 4000 * 100), "1 h 11 min");
});

test("why a SCORM upload was refused reaches the administrator in her language, nested reasons included", async () => {
  const { validateScormPackage } = await import("../../apps/web/src/lib/scorm/package.ts");
  const { scormText } = await import("../../apps/web/src/lib/scorm/messages.ts");
  const { buildZip, manifest12 } = await import("./_zip.js");
  const { getTranslations } = await import("next-intl/server");
  const refused = (bytes: Uint8Array) => {
    const r = validateScormPackage(bytes);
    assert.equal(r.ok, false);
    return (r as { error: { code: string; message: string; detail: Parameters<typeof scormText>[0] } }).error;
  };
  // Seven names that leave the package: five listed, "and 2 more".
  const unsafe = refused(buildZip(["a", "b", "c", "d", "e", "f", "g"].map((n) => ({ name: `../${n}.html`, data: "x" }))));
  // A manifest that is not XML: the parser's reason inside the manifest's.
  const doctype = refused(
    buildZip([
      { name: "imsmanifest.xml", data: manifest12({ prolog: '<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x "xx">]>' }) },
      { name: "index.html", data: "<p>x</p>" },
    ]),
  );
  // English stays what it was: the validators' `message`.
  assert.match(unsafe.message, /^These names point outside the package or are links: \.\.\/a\.html, .* and 2 more\.$/);
  assert.match(doctype.message, /^imsmanifest\.xml is not valid XML: A DOCTYPE or other declaration is not accepted in a manifest\.$/);
  for (const locale of ["hi", "bo"] as const) {
    request.locale = locale;
    const t = (await getTranslations("rtt")) as unknown as (key: string, values?: Record<string, string | number>) => string;
    const u = scormText(unsafe.detail, t);
    assert.ok(u.includes("../a.html"), `${locale}: the names are shown as they are`);
    // "… and 2 more", in her words: the list's tail message, filled in.
    const more = msg(locale, "scorm.upload.listMore").replace("{list}", "").replace("{more}", "2").trim();
    assert.ok(u.includes(more), `${locale}: ${JSON.stringify(u)} ends the list with ${JSON.stringify(more)}`);
    assert.ok(!/outside the package|more/.test(u), `${locale}: no English in ${JSON.stringify(u)}`);
    const d = scormText(doctype.detail, t);
    assert.ok(d.includes(msg(locale, "scorm.upload.doctype")), `${locale}: the parser's reason, translated: ${d}`);
    assert.ok(!/not valid XML|declaration/.test(d), `${locale}: no English in ${JSON.stringify(d)}`);
  }
});
