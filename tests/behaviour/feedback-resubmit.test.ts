// A quarter's feedback is one record per form, pairing and respondent --
// executed through the real submit action, runner and responses page.
//
// ── W3-34 (F54 remainder) ────────────────────────────────────────────────────
//
// The form stays live after it is sent (the runner pre-fills the earlier
// answers, spec 131: "most recent retake wins"), and submitFormAction always
// INSERTed. So sending a quarter's form again filed a second feedback_responses
// row beside the first: the pairing's record listed both copies with nothing
// saying which one counts, and nothing told the sender that a second submit
// files a second record. The School visit checklist is different: it is a
// repeatable field-visit form, and each visit is its own record.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const FIELDS = { fields: [{ name: "notes", kind: "textarea", label: "Notes" }] };

type Form = { id: string; slug: string };

async function withForms(body: (w: World, f: { baseline: Form; visit: Form }) => Promise<void>) {
  const w = await buildWorld("resub");
  try {
    const baseline = await w.form("baseline", "mentor", { title: "Mentor baseline", ...FIELDS }, { version: `zzz-${w.T}` });
    // Stored as kind 'baseline' and told apart by its purpose, as the seed does.
    const visit = await w.form("baseline", "mentor", { title: "School visit checklist", purpose: "school_visit", ...FIELDS }, { version: `yyy-${w.T}` });
    await w.grant(w.mentor.id);
    await body(w, { baseline, visit });
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function submitAs(who: Person, form: Form, pairingId: string, notes: string) {
  signIn(who);
  const { submitFormAction } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
  const r = await outcome(() => submitFormAction(formData({ __formId: form.id, __slug: form.slug, __pairingId: pairingId, notes })));
  assert.equal(r.kind, "redirect", describe(r));
  assert.ok((r as { to: string }).to.includes("/thanks"), (r as { to: string }).to);
}

const records = (w: World, formId: string, pairingId: string) =>
  w.q<{ notes: string; submitted_at: Date }>(
    `SELECT responses->>'notes' AS notes, submitted_at FROM feedback_responses
      WHERE form_id = $1 AND pairing_id = $2 AND respondent_user_id = $3 ORDER BY submitted_at`,
    [formId, pairingId, w.mentor.id],
  );

test("sending a quarter's form again replaces the earlier answers: one record", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.mentor, f.baseline, w.pairingA, "first answers");
    const [first] = await records(w, f.baseline.id, w.pairingA);
    await submitAs(w.mentor, f.baseline, w.pairingA, "second answers");
    const rows = await records(w, f.baseline.id, w.pairingA);
    assert.deepEqual(rows.map((r) => r.notes), ["second answers"], "one record, holding the latest answers");
    assert.ok(rows[0]!.submitted_at.getTime() >= first!.submitted_at.getTime(), "dated when it was last sent");
  });
});

test("two submissions of the same quarter's form at once still leave one record", { skip }, async () => {
  await withForms(async (w, f) => {
    await Promise.all([
      submitAs(w.mentor, f.baseline, w.pairingA, "tap one"),
      submitAs(w.mentor, f.baseline, w.pairingA, "tap two"),
    ]);
    assert.equal((await records(w, f.baseline.id, w.pairingA)).length, 1);
  });
});

test("the same form about another mentee, and a repeatable form, are records of their own", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.mentor, f.baseline, w.pairingA, "about A");
    await submitAs(w.mentor, f.baseline, w.pairingB, "about B");
    assert.deepEqual((await records(w, f.baseline.id, w.pairingA)).map((r) => r.notes), ["about A"]);
    assert.deepEqual((await records(w, f.baseline.id, w.pairingB)).map((r) => r.notes), ["about B"]);

    await submitAs(w.mentor, f.visit, w.pairingA, "visit one");
    await submitAs(w.mentor, f.visit, w.pairingA, "visit two");
    assert.deepEqual((await records(w, f.visit.id, w.pairingA)).map((r) => r.notes), ["visit one", "visit two"], "each school visit is kept");
  });
});

async function runnerHtml(slug: string, pairingId: string): Promise<string> {
  const { default: FormRunnerPage } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
  const r = await outcome(() => FormRunnerPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({ pairingId }) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value)).replace(/<!-- -->/g, "");
}

test("the runner says a quarter's form was sent, and that sending it again replaces it", { skip }, async () => {
  await withForms(async (w, f) => {
    signIn(w.mentor);
    assert.doesNotMatch(await runnerHtml(f.baseline.slug, w.pairingA), /already sent/i, "nothing to say before it is sent");
    await submitAs(w.mentor, f.baseline, w.pairingA, "first answers");
    signIn(w.mentor);
    const html = await runnerHtml(f.baseline.slug, w.pairingA);
    assert.match(html, /You already sent this form/);
    assert.match(html, /replaces your earlier answers/);

    await submitAs(w.mentor, f.visit, w.pairingA, "a visit");
    signIn(w.mentor);
    assert.doesNotMatch(await runnerHtml(f.visit.slug, w.pairingA), /already sent/i, "a repeatable form files a new record");
  });
});

test("copies filed before this change show once on the pairing's record: the latest", { skip }, async () => {
  await withForms(async (w, f) => {
    const file = (formId: string, notes: string, ago: string) =>
      w.q(
        `INSERT INTO feedback_responses (form_id, pairing_id, respondent_user_id, responses, submitted_at)
         VALUES ($1, $2, $3, $4::jsonb, now() - $5::interval)`,
        [formId, w.pairingA, w.mentor.id, JSON.stringify({ notes }), ago],
      );
    await file(f.baseline.id, "older-copy-text", "2 days");
    await file(f.baseline.id, "newer-copy-text", "1 day");
    await file(f.visit.id, "visit-one-text", "2 days");
    await file(f.visit.id, "visit-two-text", "1 day");
    signIn(w.mentor);
    const { default: PairingResponsesPage } = await import(
      "../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/responses/page.tsx"
    );
    const r = await outcome(() => PairingResponsesPage({ params: Promise.resolve({ pairingId: w.pairingA }) }));
    assert.equal(r.kind, "value", describe(r));
    const html = decodeEntities(await render((r as { value: unknown }).value));
    assert.match(html, /newer-copy-text/);
    assert.doesNotMatch(html, /older-copy-text/, "the copy a later one replaced is not listed beside it");
    assert.match(html, /visit-one-text/);
    assert.match(html, /visit-two-text/, "every school visit is listed");
  });
});
