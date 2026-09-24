// Which form each quarter of a pairing opens, and what closes a quarter --
// executed through the real pairing page, submit action and /forms catalogue.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// feedback_kind has no value for the two non-quarterly forms, so
// seed_forms_misc.ts stores the School visit checklist as kind 'baseline'
// (audience mentor) and the Endline survey as kind 'final' (audience mentee),
// telling them apart only by schema.purpose. The pairing page loaded the active
// forms with no ORDER BY and built `new Map(forms.map(f => [f.kind, f.version]))`,
// so whichever row Postgres returned last won: on the seeded database the
// mentor's Q1 "Fill progress form" opened the School visit checklist and the
// real mentor baseline could not be reached from the pairing at all. And the
// submit action advanced the quarter by kind alone, so a school-visit
// checklist -- a repeatable field-visit form -- closed Q1.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const QUARTERLY = { title: "Mentor baseline probe", fields: [{ name: "notes", kind: "textarea", label: "Notes" }] };
const SCHOOL_VISIT = {
  purpose: "schoolvisit",
  title: "School visit checklist probe",
  fields: [{ name: "notes", kind: "textarea", label: "Notes" }],
};

async function withForms(body: (w: World, quarterly: { id: string; slug: string }, visit: { id: string; slug: string }) => Promise<void>) {
  const w = await buildWorld("qforms");
  try {
    // "zzz" sorts after every other test's version, so this is also the
    // newest quarterly baseline when files run concurrently. The school-visit
    // row is inserted LAST, which is what made it win the unordered Map, and
    // its version sorts higher still, so "highest version wins" alone cannot
    // pass this test: only skipping forms with a purpose can.
    const quarterly = await w.form("baseline", "mentor", QUARTERLY, { version: `zzz-${w.T}` });
    const visit = await w.form("baseline", "mentor", SCHOOL_VISIT, { version: `zzzz-schoolvisit-${w.T}` });
    await w.grant(w.mentor.id);
    signIn(w.mentor);
    await body(w, quarterly, visit);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

test("the seeded mentee forms map each quarter to its quarterly form, in any row order", async () => {
  const { quarterlyVersionByKind } = await import("../../apps/web/src/lib/forms/quarterly.ts");
  // `select kind, version from feedback_forms where audience='mentee' and active`
  // on the seeded database, where the endline row came back last.
  const seeded = [
    { kind: "baseline", version: "1", purpose: null },
    { kind: "progress_1", version: "1", purpose: null },
    { kind: "progress_2", version: "2", purpose: null },
    { kind: "final", version: "1", purpose: null },
    { kind: "final", version: "endline-1", purpose: "endline" },
  ];
  for (const rows of [seeded, [...seeded].reverse()]) {
    assert.deepEqual(Object.fromEntries(quarterlyVersionByKind(rows)), {
      baseline: "1",
      progress_1: "1",
      progress_2: "2",
      final: "1",
    });
  }
  // A newly published version wins over the one left active, "10" over "9".
  const bumped = quarterlyVersionByKind([
    { kind: "baseline", version: "10", purpose: null },
    { kind: "baseline", version: "9", purpose: null },
  ]);
  assert.equal(bumped.get("baseline"), "10");
});

test("the mentor's Q1 link opens the quarterly baseline, never the school-visit checklist", { skip }, async () => {
  await withForms(async (w, quarterly, visit) => {
    const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
    const r = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve({}) }));
    assert.equal(r.kind, "value", describe(r));
    const html = decodeEntities(await render((r as { value: unknown }).value));
    const q1 = [...html.matchAll(/href="(\/forms\/[^"?]+)\?pairingId=[^"]*quarter=1"/g)].map((m) => m[1]);
    assert.deepEqual(q1, [`/forms/${quarterly.slug}`], "Q1 opens the mentor baseline");
    assert.doesNotMatch(html, new RegExp(visit.slug), "a school-visit checklist is not a quarter's form");
  });
});

test("submitting a school-visit checklist does not close Q1", { skip }, async () => {
  await withForms(async (w, _quarterly, visit) => {
    const { submitFormAction } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
    const r = await outcome(() =>
      submitFormAction(formData({ __formId: visit.id, __slug: visit.slug, __pairingId: w.pairingA, notes: "visited on Tuesday" })),
    );
    assert.equal(r.kind, "redirect", describe(r));
    assert.ok((r as { to: string }).to.startsWith(`/forms/${visit.slug}/thanks`), (r as { to: string }).to);
    const [{ current_quarter }] = await w.q<{ current_quarter: number }>(`SELECT current_quarter FROM mentor_pairings WHERE id = $1`, [w.pairingA]);
    assert.equal(current_quarter, 1, "a field-visit form is repeatable and closes no quarter");
  });
});

test("the /forms catalogue names each form by its own title", { skip }, async () => {
  await withForms(async (_w, _quarterly, visit) => {
    const { default: FormsIndexPage } = await import("../../apps/web/src/app/(authenticated)/forms/page.tsx");
    const r = await outcome(() => FormsIndexPage());
    assert.equal(r.kind, "value", describe(r));
    const html = decodeEntities(await render((r as { value: unknown }).value));
    assert.match(html, /School visit checklist probe/, "two rows both called 'Baseline for mentors' cannot be told apart");
    assert.match(html, /Mentor baseline probe/);
    assert.ok(visit.slug);
  });
});
