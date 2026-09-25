// A retired RTT subject disappears from what teachers see, rendered for real.
//
// ── THE DEFECT (F43) ─────────────────────────────────────────────────────────
//
// The admin grid exposes an Active flag on RTT subjects and the self-paced hub
// honours it, but /rtt selected every rtt_subjects row -- listing, counting and
// linking an inactive one -- and the subject page never checked the flag. An
// operator retiring a subject saw no effect on the main surface teachers use.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL /rtt, subject page, progress action and webinar calendar, through
// the app's own @gml/db pool, for users of a small committed programme
// (./_rtt-world.ts). Only auth() is stubbed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, outcome, form, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, openingTags, attr, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(closeAppDb);

const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const hrefs = (html: string) => openingTags(html, "a").map((t) => attr(t, "href") ?? "");

async function hub(user: TestUser): Promise<string> {
  signIn(user);
  const { default: RttIndexPage } = await import("../../apps/web/src/app/(authenticated)/rtt/page.tsx");
  return render(withAppRouter(await RttIndexPage({ searchParams: Promise.resolve({}) })));
}

async function subject(user: TestUser, id: string) {
  signIn(user);
  const { default: RttSubjectPage } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
  return outcome(async () =>
    render(withAppRouter(await RttSubjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }))),
  );
}

test("F43: /rtt neither lists, counts nor links an inactive subject for a teacher; an admin sees it marked", { skip }, async () => {
  const w = await rttWorld("f43-hub");
  try {
    const live = await w.subject({ name: `Live ${w.T}` });
    const retired = await w.subject({ name: `Retired ${w.T}`, active: false });
    const quiz = await w.quiz(retired);

    const t = await hub(w.teacher);
    assert.ok(!text(t).includes(`Retired ${w.T}`), "a retired subject is not listed");
    assert.ok(!hrefs(t).includes(`/rtt/subject/${retired}`), "nor linked");
    assert.ok(hrefs(t).includes(`/rtt/subject/${live}`), "a live one is");
    assert.ok(!hrefs(t).includes(`/quizzes/${quiz.slug}`), "its quizzes are not open assessments");
    // The phase card for this world's phase counts only what is listed.
    const card = text(t).match(new RegExp(`P ${w.T}`.slice(0, 24) + "\\s+(\\d+) subjects"));
    assert.ok(card, "the world's phase card");
    assert.equal(card[1], "1", "the phase card counts the live subject only");

    const a = await hub(w.admin);
    assert.ok(hrefs(a).includes(`/rtt/subject/${retired}`), "an admin can still reach it, to re-activate it");
    assert.match(text(a), new RegExp(`Inactive[^.]{0,40}Retired ${w.T}|Retired ${w.T}[^.]{0,40}Inactive`));
  } finally {
    await w.cleanup();
  }
});

test("F43: an inactive subject's page is not found for a teacher; an admin sees it marked inactive", { skip }, async () => {
  const w = await rttWorld("f43-page");
  try {
    const retired = await w.subject({ name: `Retired ${w.T}`, active: false });
    const lesson = await w.lesson(await w.module(retired, 1), 1);
    assert.deepEqual(await subject(w.teacher, retired), { kind: "notFound" });
    const admin = await subject(w.admin, retired);
    assert.equal(admin.kind, "returned");
    assert.match(text(String((admin as { value: string }).value)), /Inactive/);

    // Nor can a teacher record progress on it.
    signIn(w.teacher);
    const { markProgressAction } = await import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/actions.ts");
    assert.deepEqual(
      await outcome(() => markProgressAction(form({ kind: "lesson", itemId: lesson, done: "true" }))),
      { kind: "notFound" },
    );
  } finally {
    await w.cleanup();
  }
});

test("F43: the webinar calendar leaves out an inactive subject's sessions for a teacher", { skip }, async () => {
  const w = await rttWorld("f43-cal");
  try {
    const live = await w.subject();
    const retired = await w.subject({ active: false });
    const soon = new Date(Date.now() + 2 * 3_600_000);
    await w.session(live, { sequence: 1, title: `Live webinar ${w.T}`, scheduledAt: soon });
    await w.session(retired, { sequence: 1, title: `Retired webinar ${w.T}`, scheduledAt: soon });
    signIn(w.teacher);
    const { default: Calendar } = await import("../../apps/web/src/app/(authenticated)/rtt/online/synchronous/page.tsx");
    const cal = text(await render(withAppRouter(await Calendar())));
    assert.ok(cal.includes(`Live webinar ${w.T}`));
    assert.ok(!cal.includes(`Retired webinar ${w.T}`), "a retired subject's webinar is not on the calendar");
  } finally {
    await w.cleanup();
  }
});
