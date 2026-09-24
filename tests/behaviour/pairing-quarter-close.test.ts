// What closes a pairing's quarter, executed through the real submit action and
// pairing page.
//
// ── F55: THE FIRST SUBMISSION OF ANY KIND, BY ANYONE, CLOSED THE QUARTER ─────
//
// current_quarter advanced on the first submission of a quarter's form kind by
// any respondent. When the mentee submitted her baseline, the mentor's Q1 card
// flipped to "Closed" though the mentor had not filled the Q1 form, and nothing
// prompted her any more. The page offers administrators "a preview of the
// mentor side" -- but the links carried the real pairingId, so an
// administrator's preview submission was filed as the pairing's feedback and
// closed the quarter too.
//
// The rule the pairing page states is that the MENTOR's quarterly form closes
// the quarter ("Mentor must complete an 8-question feedback form at the end of
// each quarter ... Closes the quarter on submit").

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const FIELDS = { fields: [{ name: "notes", kind: "textarea", label: "Notes" }] };

type Forms = { mentor: { id: string; slug: string }; mentee: { id: string; slug: string } };

async function withForms(body: (w: World, f: Forms) => Promise<void>) {
  const w = await buildWorld("qclose");
  try {
    // "zzz" versions: newest quarterly baseline for either audience, even with
    // other test files' forms active at the same time.
    const mentor = await w.form("baseline", "mentor", { title: "Mentor baseline", ...FIELDS }, { version: `zzz-${w.T}` });
    const mentee = await w.form("baseline", "mentee", { title: "Mentee baseline", ...FIELDS }, { version: `zzz-${w.T}` });
    for (const p of [w.mentor, w.teacherA, w.admin]) await w.grant(p.id);
    await body(w, { mentor, mentee });
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function submitAs(who: Person, form: { id: string; slug: string }, pairingId: string) {
  signIn(who);
  const { submitFormAction } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
  const r = await outcome(() => submitFormAction(formData({ __formId: form.id, __slug: form.slug, __pairingId: pairingId, notes: `by ${who.role}` })));
  assert.equal(r.kind, "redirect", describe(r));
  assert.ok((r as { to: string }).to.includes("/thanks"), (r as { to: string }).to);
}

async function quarter(w: World, pairingId: string): Promise<number> {
  const [{ current_quarter }] = await w.q<{ current_quarter: number }>(`SELECT current_quarter FROM mentor_pairings WHERE id = $1`, [pairingId]);
  return current_quarter;
}

test("the mentee's baseline does not close Q1; the mentor's does", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.teacherA, f.mentee, w.pairingA);
    assert.equal(await quarter(w, w.pairingA), 1, "the mentor has not filled Q1 yet");
    await submitAs(w.mentor, f.mentor, w.pairingA);
    assert.equal(await quarter(w, w.pairingA), 2);
  });
});

test("an administrator's submission against a pairing does not close its quarter", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.admin, f.mentor, w.pairingA);
    assert.equal(await quarter(w, w.pairingA), 1);
  });
});

async function pairingHtml(who: Person, pairingId: string) {
  signIn(who);
  const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
  const r = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId }), searchParams: Promise.resolve({}) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value));
}

test("an administrator's quarter links are previews that file nothing against the pairing", { skip }, async () => {
  await withForms(async (w, f) => {
    const html = await pairingHtml(w.admin, w.pairingA);
    const q1 = /<a\b[^>]*aria-label="[^"]*Q1[^"]*"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(q1, new RegExp(`href="/forms/${f.mentor.slug}"`), q1 || "no Q1 link");
    assert.doesNotMatch(q1, /pairingId=/);
  });
});

test("once the mentee has sent her quarter's form, her card says so instead of asking again", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.teacherA, f.mentee, w.pairingA);
    const html = await pairingHtml(w.teacherA, w.pairingA);
    assert.doesNotMatch(html, /aria-label="Fill Q1 progress form"/);
    assert.match(html, /Submitted/);
    assert.match(html, new RegExp(`href="/mentorship/${w.pairingA}/responses"`));
  });
});
