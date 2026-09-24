// Observation stage forms are validated on the SERVER before a cycle advances.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// submitPre/Observer/PostFormAction stored every non-`__` key of the posted
// FormData verbatim (collectResponses) and then advanced the cycle -- a
// forward-only transition with no way back. There was no required-field check,
// no trimming, no length cap and no allow-list: a pre-form of `{}`, an observer
// rubric of three spaces and arbitrary extra keys were all accepted, and each
// permanently moved the cycle on with an empty record. The textarea's
// `required` attribute is a browser convenience; whitespace satisfies it and a
// direct POST to the action skips it entirely.
//
// And nothing showed WHO submitted a form. Spec 117 D-004 lets an observer,
// mentor or administrator submit the teacher's pre/post form on her behalf
// (transcribing a paper draft), which is recorded in submitted_by_user_id --
// and displayed nowhere, so the teacher could not tell someone else had
// written "her" reflection.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real server actions are executed through ./_server-actions.ts, as a
// no-JS browser would post them.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, openingTags, attr } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld, type ObservationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

const actions = () => import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");

async function state(w: ObservationWorld, cycleId: string) {
  const status = (await w.c.query(`SELECT status FROM observation_cycles WHERE id = $1`, [cycleId])).rows[0].status;
  const forms = (await w.c.query(`SELECT kind, responses FROM observation_forms WHERE cycle_id = $1`, [cycleId])).rows;
  return { status, forms };
}

test("a blank or missing answer is refused, and the cycle does not advance", { skip }, async () => {
  const w = await observationWorld("obsval");
  try {
    const { submitPreFormAction, submitObserverFormAction } = await actions();
    for (const u of [w.teacher, w.observer]) await w.grant(u.id);

    const nominated = await w.cycle({ status: "nominated" });
    signIn(w.teacher);
    for (const body of [{ lessonPlanSummary: "   " }, {}]) {
      const r = await outcome(() => submitPreFormAction(form({ cycleId: nominated.id, ...body })));
      assert.deepEqual(r, {
        kind: "redirect",
        location: `/observation/${nominated.id}?error=invalid_form&field=lessonPlanSummary`,
      });
      assert.deepEqual(await state(w, nominated.id), { status: "nominated", forms: [] }, "nothing recorded, nothing advanced");
    }

    const preIn = await w.cycle({ status: "pre_submitted" });
    signIn(w.observer);
    const r = await outcome(() => submitObserverFormAction(form({ cycleId: preIn.id, narrativeComments: " \n\t " })));
    assert.equal(r.kind, "redirect");
    assert.match((r as { location: string }).location, /\?error=invalid_form&field=narrativeComments$/);
    assert.deepEqual(await state(w, preIn.id), { status: "pre_submitted", forms: [] });
  } finally {
    await w.cleanup();
  }
});

test("an over-long answer is refused", { skip }, async () => {
  const w = await observationWorld("obslen");
  try {
    const { submitPostFormAction } = await actions();
    await w.grant(w.teacher.id);
    const observed = await w.cycle({ status: "observed" });
    signIn(w.teacher);
    const r = await outcome(() => submitPostFormAction(form({ cycleId: observed.id, whatWorked: "x".repeat(5001) })));
    assert.equal(r.kind, "redirect");
    assert.match((r as { location: string }).location, /error=invalid_form&field=whatWorked/);
    assert.equal((await state(w, observed.id)).status, "observed");
  } finally {
    await w.cleanup();
  }
});

test("only the stage's own questions are stored, trimmed; unknown keys are dropped", { skip }, async () => {
  const w = await observationWorld("obsallow");
  try {
    const { submitPreFormAction } = await actions();
    await w.grant(w.teacher.id);
    const cyc = await w.cycle({ status: "nominated" });
    signIn(w.teacher);
    const r = await outcome(() =>
      submitPreFormAction(form({ cycleId: cyc.id, lessonPlanSummary: "  Fractions on a number line  ", injected: "arbitrary" })),
    );
    assert.deepEqual(r, { kind: "redirect", location: `/observation/${cyc.id}` });
    assert.deepEqual(await state(w, cyc.id), {
      status: "pre_submitted",
      forms: [{ kind: "pre", responses: { lessonPlanSummary: "Fractions on a number line" } }],
    });
  } finally {
    await w.cleanup();
  }
});

async function renderCycle(user: TestUser, cycleId: string, searchParams: Record<string, string> = {}) {
  signIn(user);
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  const html = await render(
    withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve(searchParams) })),
  );
  return html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

test("a form submitted on the teacher's behalf says so, and by whom", { skip }, async () => {
  const w = await observationWorld("obsbehalf");
  try {
    const { submitPreFormAction } = await actions();
    await w.grant(w.mentor.id);
    const cyc = await w.cycle({ status: "nominated" });
    signIn(w.mentor);
    await outcome(() => submitPreFormAction(form({ cycleId: cyc.id, lessonPlanSummary: "Transcribed from paper" })));
    const out = await renderCycle(w.teacher, cyc.id);
    assert.ok(
      out.includes(`Submitted by ${w.mentor.name} on behalf of the teacher`),
      "the teacher must be able to see that someone else wrote her pre-form",
    );
  } finally {
    await w.cleanup();
  }
});

test("the refusal is explained on the page, naming the question", { skip }, async () => {
  const w = await observationWorld("obsmsg");
  try {
    const cyc = await w.cycle({ status: "nominated" });
    const out = await renderCycle(w.teacher, cyc.id, { error: "invalid_form", field: "lessonPlanSummary" });
    assert.match(out, /Lesson plan summary/);
    assert.match(out, /nothing was recorded/i);
  } finally {
    await w.cleanup();
  }
});

// The server refuses an answer over MAX_TEXT_LENGTH, and the refusal is a
// redirect. The inputs had no maxLength, so an observer who wrote a long
// rubric on a phone found out only after submitting, from a message that said
// "blank or too long" without saying how long is too long.

test("every stage input carries the server's length cap, and the refusal states it", { skip }, async () => {
  const w = await observationWorld("obscap");
  try {
    const { MAX_TEXT_LENGTH } = await import("../../apps/web/src/lib/forms/validate.ts");
    const html = async (user: TestUser, cycleId: string) => {
      signIn(user);
      const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
      return render(
        withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve({}) })),
      );
    };
    const stages: Array<[TestUser, string, string]> = [
      [w.teacher, "nominated", "lessonPlanSummary"],
      [w.observer, "pre_submitted", "narrativeComments"],
      [w.teacher, "observed", "whatWorked"],
    ];
    for (const [user, status, field] of stages) {
      const cyc = await w.cycle({ status });
      const tag = openingTags(await html(user, cyc.id), "textarea").find((t) => attr(t, "name") === field);
      assert.ok(tag, `the ${status} stage renders its ${field} input`);
      // React writes the attribute as maxLength; HTML attribute names are case-insensitive.
      assert.equal(attr(tag!, "maxLength") ?? attr(tag!, "maxlength"), String(MAX_TEXT_LENGTH), `${field} is capped where the server caps it`);
    }

    const cyc = await w.cycle({ status: "nominated" });
    const out = await renderCycle(w.teacher, cyc.id, { error: "invalid_form", field: "lessonPlanSummary" });
    assert.ok(out.includes(`${MAX_TEXT_LENGTH.toLocaleString("en-IN")} characters`), `the message states the limit: ${out}`);
  } finally {
    await w.cleanup();
  }
});
