// What the form runner and the catalogue tell the person filling a form in:
// whose form it is, what it is called, where "back" goes, and how much is
// done. Executed through the real runner, catalogue and submit action.
//
// ── F61 ──────────────────────────────────────────────────────────────────────
//
// A mentor with four or five mentees fills four quarterly forms per pairing,
// and the runner opened from a pairing never named the mentee. The four
// seeded mentor forms have no schema title, so the heading read
// "baseline · mentor". The only back link was "← Inbox", though she came from
// the pairing, and the inbox has no forms. On /forms a row said "Answered" as
// soon as ONE of her pairings was answered. And the submit action's
// form_not_found / invalid_form_submit errors redirected to /inbox?error=...,
// which the inbox ignores.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

// Untitled, as the four seeded mentor forms are.
const UNTITLED = { fields: [{ name: "notes", kind: "textarea", label: "Notes" }] };

async function withWorld(body: (w: World, form: { id: string; slug: string }) => Promise<void>) {
  const w = await buildWorld("fctx");
  try {
    const form = await w.form("baseline", "mentor", UNTITLED);
    await w.grant(w.mentor.id);
    signIn(w.mentor);
    await body(w, form);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function runnerHtml(slug: string, sp: Record<string, string>) {
  const { default: FormRunnerPage } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
  const r = await outcome(() => FormRunnerPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value)).replace(/<!-- -->/g, "");
}

async function formsHtml(sp: Record<string, string> = {}) {
  const { default: FormsIndexPage } = await import("../../apps/web/src/app/(authenticated)/forms/page.tsx");
  const r = await outcome(() => FormsIndexPage({ searchParams: Promise.resolve(sp) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value)).replace(/<!-- -->/g, "");
}

test("the runner names the mentee the form is about, and goes back to her pairing", { skip }, async () => {
  await withWorld(async (w, form) => {
    const html = await runnerHtml(form.slug, { pairingId: w.pairingA, quarter: "1" });
    assert.match(html, new RegExp(`About ${w.teacherA.name}`), "the mentor must see whose form this is before she seals it");
    assert.match(html, new RegExp(`href="/mentorship/${w.pairingA}"[^>]*>← Pairing`));
    assert.doesNotMatch(html, /← Inbox/);
  });
});

// The about-line printed ?quarter= verbatim ("About X · Q<anything>"), so a
// crafted link put a wrong or odd quarter on the header meant to reassure the
// mentor. Only 1..4 is taken from the URL; otherwise the pairing's own.
test("the runner's about-line takes only a quarter 1..4 from the URL, else the pairing's", { skip }, async () => {
  await withWorld(async (w, form) => {
    await w.q(`UPDATE mentor_pairings SET current_quarter = 2 WHERE id = $1`, [w.pairingA]);
    const about = async (quarter: string) =>
      /data-testid="form-about"[^>]*>([^<]*)</.exec(await runnerHtml(form.slug, { pairingId: w.pairingA, quarter }))?.[1];
    assert.equal(await about("3"), `About ${w.teacherA.name} · Q3`);
    for (const odd of ["9", "0", "2.5", "Q3 — closed", "1e0x"]) {
      assert.equal(await about(odd), `About ${w.teacherA.name} · Q2`, `?quarter=${odd}`);
    }
  });
});

test("an untitled form is headed readably, not 'baseline · mentor'", { skip }, async () => {
  await withWorld(async (w, form) => {
    const html = await runnerHtml(form.slug, { pairingId: w.pairingA });
    assert.match(html, /<h1[^>]*>Baseline — Mentor/);
  });
});

test("a form opened without a pairing goes back to /forms", { skip }, async () => {
  await withWorld(async (w, form) => {
    // The bare form asks for the mentorship password too: its draft can be one
    // written before drafts had a pairing (forms-mentorship-gate.test.ts).
    await w.grant(w.admin.id);
    signIn(w.admin);
    const html = await runnerHtml(form.slug, {});
    assert.match(html, /href="\/forms"[^>]*>← Forms/);
  });
});

test("/forms says how many of a mentor's pairings a form is answered for", { skip }, async () => {
  await withWorld(async (w, form) => {
    await w.q(`INSERT INTO feedback_responses (form_id, pairing_id, respondent_user_id, responses) VALUES ($1, $2, $3, '{}'::jsonb)`, [
      form.id,
      w.pairingA,
      w.mentor.id,
    ]);
    const html = await formsHtml();
    assert.match(html, /1 of 2 answered/, "one of her two mentees is not 'Answered'");
  });
});

test("a submission for a form that no longer exists lands on /forms with the reason shown", { skip }, async () => {
  await withWorld(async (w) => {
    const { submitFormAction } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
    const r = await outcome(() =>
      submitFormAction(formData({ __formId: "00000000-0000-4000-8000-000000000000", __slug: "baseline-mentor-gone", __pairingId: w.pairingA })),
    );
    assert.deepEqual(r, { kind: "redirect", to: "/forms?error=form_not_found" });
    assert.match(await formsHtml({ error: "form_not_found" }), /no longer available/);
  });
});
