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
    // Which baseline/mentor form wins depends on what other test files have
    // active at the same moment; that it is a bare preview link does not.
    assert.match(q1, /href="\/forms\/baseline-mentor-[^"?]+"/, q1 || "no Q1 link");
    assert.doesNotMatch(q1, /pairingId=/);
    assert.ok(f.mentor.slug);
  });
});

// ── W3-31 ────────────────────────────────────────────────────────────────────
//
// Only the mentor's form closes a quarter, so a quarter can close before the
// mentee has sent hers. A closed quarter offered only "View responses", and
// the responses page shows a mentee her own responses -- none -- so the
// pairing page, where her quarterly forms live, led her to an empty page and
// no longer to her form.
test("a quarter the mentor closed still offers the mentee her own form until she sends it", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.mentor, f.mentor, w.pairingA);
    assert.equal(await quarter(w, w.pairingA), 2, "precondition: the mentor's form closed Q1");

    const formHref = `href="/forms/${f.mentee.slug}?pairingId=${w.pairingA}&quarter=1"`;
    const before = await pairingHtml(w.teacherA, w.pairingA);
    assert.ok(before.includes(formHref), "her Q1 form is still one tap from the pairing");

    await submitAs(w.teacherA, f.mentee, w.pairingA);
    const after = await pairingHtml(w.teacherA, w.pairingA);
    assert.ok(!after.includes(formHref), "once sent, it is not asked for again");
    const q1 = /<a\b[^>]*aria-label="View Q1 responses"[^>]*>/.exec(after)?.[0] ?? "";
    assert.ok(q1.includes(`href="/mentorship/${w.pairingA}/responses"`), q1 || "no View Q1 responses link");

    const mentor = await pairingHtml(w.mentor, w.pairingA);
    assert.match(mentor, /aria-label="View Q1 responses"/, "the mentor, whose form closed it, reads the record");
    assert.ok(!mentor.includes(`href="/forms/${f.mentor.slug}?pairingId=${w.pairingA}&quarter=1"`));
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
