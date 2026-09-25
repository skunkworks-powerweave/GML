// Mentorship feedback behind the mentorship section password, executed
// through the real /forms page, form runner and submit action.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The section password is a hard product requirement, and /mentorship asserts
// it in its layout AND inside every server action ("a gate that guards only
// the reading of a page and none of the writing does not meet it"). But
// /forms and /forms/[slug] sit outside /mentorship, and neither asked. So
// anyone holding a mentor's session -- a shared school phone -- could, with no
// password:
//   - read the mentee roster on /forms, one named link per pairing;
//   - open a pairing's form and read everything the mentor had written about
//     that mentee (the runner pre-fills the prior response);
//   - file new feedback, and advance the pairing's quarter.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type World } from "./_mentorship.js";
import { render } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const SCHEMA = { title: "Gate probe form", fields: [{ name: "notes", kind: "textarea", label: "Notes" }] };

async function runner() {
  return import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
}

async function withWorld(body: (w: World, form: { id: string; slug: string }) => Promise<void>) {
  const w = await buildWorld("fgate");
  try {
    const form = await w.form("baseline", "mentor", SCHEMA);
    signIn(w.mentor);
    await body(w, form);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

test("without the mentorship password the runner does not show what the mentor wrote about a mentee", { skip }, async () => {
  await withWorld(async (w, form) => {
    await w.q(
      `INSERT INTO feedback_responses (form_id, pairing_id, respondent_user_id, responses) VALUES ($1, $2, $3, $4::jsonb)`,
      [form.id, w.pairingA, w.mentor.id, JSON.stringify({ notes: "private assessment of mentee A" })],
    );
    const { default: FormRunnerPage } = await runner();
    const open = () =>
      outcome(() => FormRunnerPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId: w.pairingA }) }));

    const locked = await open();
    assert.equal(locked.kind, "redirect", `expected the gate, got ${describe(locked)}`);
    const to = (locked as { to: string }).to;
    assert.ok(to.startsWith("/gate/mentorship?next="), to);
    assert.equal(new URL(to, "http://x").searchParams.get("next"), `/forms/${form.slug}?pairingId=${w.pairingA}`, "back to this form once unlocked");

    await w.grant(w.mentor.id);
    const unlocked = await open();
    assert.equal(unlocked.kind, "value", describe(unlocked));
    assert.match(await render((unlocked as { value: unknown }).value), /private assessment of mentee A/);
  });
});

test("without the mentorship password a submission is refused and the quarter does not move", { skip }, async () => {
  await withWorld(async (w, form) => {
    const { submitFormAction } = await runner();
    const r = await outcome(() =>
      submitFormAction(formData({ __formId: form.id, __slug: form.slug, __pairingId: w.pairingA, notes: "filed without the password" })),
    );
    assert.equal(r.kind, "redirect", describe(r));
    assert.ok((r as { to: string }).to.startsWith("/gate/mentorship?next="), (r as { to: string }).to);

    const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM feedback_responses WHERE pairing_id = $1`, [w.pairingA]);
    assert.equal(n, 0, "no feedback may be filed without the section password");
    const [{ current_quarter }] = await w.q<{ current_quarter: number }>(`SELECT current_quarter FROM mentor_pairings WHERE id = $1`, [w.pairingA]);
    assert.equal(current_quarter, 1);
  });
});

test("without the mentorship password /forms does not list the mentees", { skip }, async () => {
  await withWorld(async (w, form) => {
    const { default: FormsIndexPage } = await import("../../apps/web/src/app/(authenticated)/forms/page.tsx");
    const page = async () => {
      const r = await outcome(() => FormsIndexPage());
      assert.equal(r.kind, "value", describe(r));
      return render((r as { value: unknown }).value);
    };

    const locked = await page();
    assert.doesNotMatch(locked, new RegExp(w.teacherA.name), "mentee names are mentorship data");
    assert.doesNotMatch(locked, new RegExp(w.pairingA), "and so are the pairing ids");
    assert.match(locked, /href="\/gate\/mentorship\?next=%2Fforms"/, "the page says how to unlock");

    await w.grant(w.mentor.id);
    const unlocked = await page();
    assert.match(unlocked, new RegExp(w.teacherA.name));
    assert.match(unlocked, new RegExp(`href="/forms/${form.slug}\\?pairingId=${w.pairingA}"`));
  });
});

// B#5: the catalogue used to send every mentor with more than one mentee to
// /inbox, which has no form on it. lib/forms/catalogue-links.ts is executed by
// form-catalogue-links.test.ts, but reverting the PAGE's use of it left every
// test green; this renders the page itself.
test("B#5: /forms gives a mentor with two mentees one link per mentee, never /inbox", { skip }, async () => {
  await withWorld(async (w, form) => {
    await w.grant(w.mentor.id);
    const { default: FormsIndexPage } = await import("../../apps/web/src/app/(authenticated)/forms/page.tsx");
    const r = await outcome(() => FormsIndexPage());
    assert.equal(r.kind, "value", describe(r));
    const html = await render((r as { value: unknown }).value);
    const rowLinks = [...html.matchAll(/<a\b[^>]*data-testid="form-link"[^>]*>/g)]
      .map((m) => /href="([^"]*)"/.exec(m[0])?.[1] ?? "")
      .filter((href) => href.startsWith(`/forms/${form.slug}`) || href === "/inbox");
    assert.deepEqual(
      rowLinks.sort(),
      [`/forms/${form.slug}?pairingId=${w.pairingA}`, `/forms/${form.slug}?pairingId=${w.pairingB}`].sort(),
    );
    assert.doesNotMatch(html, /data-testid="form-link"[^>]*href="\/inbox"|href="\/inbox"[^>]*data-testid="form-link"/);
  });
});
