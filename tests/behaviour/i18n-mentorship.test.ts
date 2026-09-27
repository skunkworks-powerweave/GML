// The mentorship and forms pages speak the reader's language -- executed.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// A user who picked Hindi or Bhoti got a translated menu over English pages:
// the pairings list, the pairing page (meetings, quarter strip, commitments),
// the forms catalogue and runner, the thank-you card, and the form runners'
// own chrome (Submit, the autosave notice, validation messages) were all
// written into the components in English. So were the inbox rows a meeting
// or a final form writes, whatever language their RECIPIENT reads.
//
// What is rendered here is the real page or component, with next-intl's real
// translator over the app's own bundles (tests/behaviour/_ui.ts), in Hindi and
// in Bhoti, and each check pairs a string from the mentorship namespace that
// must appear with the English original that must not.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, renderSync, withAppRouter, request, mount, hostElements, textOf, decodeEntities, h } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppPool();
});

const APP = "../../apps/web/src/app/(authenticated)";

/** Run `body` with the fake request in `locale`, back to English afterwards. */
async function inLocale<T>(locale: "hi" | "bo", body: () => Promise<T> | T): Promise<T> {
  request.locale = locale;
  try {
    return await body();
  } finally {
    request.locale = "en";
  }
}

const text = (html: string) => decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

// ── the form runners (no database) ───────────────────────────────────────────

const SCHEMA = {
  fields: [
    { name: "focus", label: "Focus", kind: "select", options: ["Reading", "Maths"] },
    { name: "confidence", label: "Confidence", kind: "likert", required: true },
    { name: "stars", label: "Stars", kind: "rating" },
  ],
};

test("the desktop form runner's own words are Hindi; the questions stay as stored", async () => {
  const { FormRenderer } = await import("../../apps/web/src/components/forms/FormRenderer.tsx");
  const html = await inLocale("hi", () => renderSync(h(FormRenderer as never, { schema: SCHEMA, onSubmit: async () => undefined } as never)));
  const out = text(html);
  for (const [hi, en] of [
    ["चुनें…", "Choose…"],
    ["पूरी तरह असहमत", "Strongly disagree"],
    ["अभी रेटिंग नहीं दी गई", "Not yet rated"],
    ["जमा करें", "Submit"],
  ]) {
    assert.ok(out.includes(hi!), `"${hi}" is shown`);
    assert.ok(!out.includes(en!), `"${en}" is not`);
  }
  assert.match(html, /aria-label="5 में से 1 रेटिंग दें"/, "the star buttons are named in Hindi");
  // Data is data: the administrator's question labels and options as entered.
  assert.ok(out.includes("Confidence") && out.includes("Reading"));
});

test("the phone form runner steps, and refuses a blank answer, in Bhoti", async () => {
  const { MobileFormRunner } = await import("../../apps/web/src/components/forms/MobileFormRunner.tsx");
  const schema = { fields: [{ name: "note", label: "Note", kind: "text", required: true }, { name: "b", label: "B", kind: "text" }] };
  const m = mount(MobileFormRunner as (p: unknown) => unknown, { schema, onSubmit: async () => undefined }, { intl: "bo" });
  const shown = () => textOf(m.rerender());
  assert.ok(shown().includes("༢ ལས་དྲི་བ་ ༡") || shown().includes("2 ལས་དྲི་བ་ 1"), `the step counter is Bhoti: ${shown()}`);
  assert.ok(!shown().includes("Question 1 of 2"));
  const dot = hostElements(m.rerender()).find((el) => el.props["data-testid"] === "mobile-progress-dot-0")!;
  assert.doesNotMatch(String(dot.props["aria-label"]), /Step/);
  assert.ok(shown().includes("རྗེས་མ། →") && !shown().includes("Next →"));
  // Next on a blank required answer: the validator's message, in Bhoti.
  const next = hostElements(m.rerender()).find((el) => el.props["data-testid"] === "mobile-form-next")!;
  (next.props.onClick as () => void)();
  const alert = hostElements(m.rerender()).find((el) => el.props.role === "alert");
  assert.ok(alert, "the blank answer is refused");
  assert.equal(textOf(alert), "Note ངེས་པར་དགོས།");
  assert.doesNotMatch(textOf(alert), /is required/);
});

// ── the pages (database) ─────────────────────────────────────────────────────

async function page(who: Person, run: () => Promise<unknown>): Promise<string> {
  signIn(who);
  request.cookies = { "gml-device": "desktop" };
  try {
    const r = await outcome(run);
    assert.equal(r.kind, "value", describe(r));
    return text(await render(withAppRouter((r as { value: unknown }).value)));
  } finally {
    request.cookies = {};
  }
}

async function withWorld(prefix: string, body: (w: World) => Promise<void>) {
  const w = await buildWorld(prefix);
  try {
    for (const p of [w.admin, w.mentor, w.teacherA, w.teacherB]) await w.grant(p.id);
    await body(w);
  } finally {
    signIn(null);
    request.locale = "en";
    await w.q(`DELETE FROM user_prefs WHERE user_id = ANY($1::uuid[])`, [[w.admin.id, w.mentor.id, w.teacherA.id, w.teacherB.id]]);
    await w.cleanup();
  }
}

test("the pairing page is Hindi for a Hindi reader, and Bhoti for a Bhoti one", { skip }, async () => {
  await withWorld("i18npair", async (w) => {
    // A quarterly form for the mentor, so Q1's card links to it.
    await w.form("baseline", "mentor", { fields: [{ name: "summary", label: "Summary", kind: "text" }] }, { version: `zz${w.T}` });
    await w.q(`INSERT INTO mentor_meetings (pairing_id, scheduled_at, duration_min, notes) VALUES ($1, now() - interval '3 days', '45', $2)`, [
      w.pairingA,
      `notes ${w.T}`,
    ]);
    await w.q(
      `UPDATE mentor_pairings SET commitments = jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'text', $2::text, 'who', 'mentee', 'due', 'Wk 3', 'done', false)) WHERE id = $1`,
      [w.pairingA, `commitment ${w.T}`],
    );
    const { default: PairingPage } = await import(`${APP}/mentorship/[pairingId]/page.tsx`);
    const run = () => PairingPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve({}) });

    const hi = await inLocale("hi", () => page(w.mentor, run));
    for (const [translated, english] of [
      ["बैठकें और संपर्क", "Meetings & touchpoints"],
      ["प्रतिबद्धता रजिस्टर", "Commitments register"],
      ["+ बैठक दर्ज करें", "+ Log meeting"],
      ["तिमाही वीडियो", "Quarterly videos"],
      ["सक्रिय", "Started"],
    ]) {
      assert.ok(hi.includes(translated!), `Hindi: "${translated}" is shown`);
      assert.ok(!hi.includes(english!), `Hindi: "${english}" is not`);
    }
    assert.ok(hi.includes(`notes ${w.T}`) && hi.includes(`commitment ${w.T}`), "what people typed is shown as typed");
    assert.ok(hi.includes("मेंटी · Wk 3"), "whose commitment it is, in Hindi, beside the due note as typed");

    const bo = await inLocale("bo", () => page(w.mentor, run));
    for (const [translated, english] of [
      ["ཚོགས་འདུ་དང་འབྲེལ་བ།", "Meetings & touchpoints"],
      ["ཁས་ལེན་ཐོ་དེབ།", "Commitments register"],
      ["ཡར་རྒྱས་ཤོག་བྱང་འགེངས། →", "Fill progress form →"],
    ]) {
      assert.ok(bo.includes(translated!), `Bhoti: "${translated}" is shown`);
      assert.ok(!bo.includes(english!), `Bhoti: "${english}" is not`);
    }

    // An ?error= alert, too.
    const alert = await inLocale("bo", () =>
      page(w.mentor, () => PairingPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve({ error: "empty_commitment" }) })),
    );
    assert.ok(alert.includes("ཁས་ལེན་མ་སྣོན་གོང་"), "the refusal is Bhoti");
    assert.ok(!alert.includes("A commitment needs some text"));
  });
});

test("the pairings list and the forms catalogue are Bhoti for a Bhoti reader", { skip }, async () => {
  await withWorld("i18nlist", async (w) => {
    await w.form("baseline", "mentor", { fields: [{ name: "summary", label: "Summary", kind: "text" }] });
    const { default: ListPage } = await import(`${APP}/mentorship/page.tsx`);
    const list = await inLocale("bo", () => page(w.mentor, () => ListPage({ searchParams: Promise.resolve({}) })));
    assert.ok(list.includes("ཟུང་འབྲེལ།") && list.includes("བསྐྱར་ཞིབ་འོག"), "title and status chips in Bhoti");
    assert.ok(!list.includes("In review") && !list.includes("Showing "), list);

    const { default: FormsPage } = await import(`${APP}/forms/page.tsx`);
    const forms = await inLocale("bo", () => page(w.mentor, () => FormsPage({ searchParams: Promise.resolve({}) })));
    assert.ok(forms.includes("ལམ་སྟོན་འཁོར་རིམ་གྱི་བསམ་འཆར་ཤོག་བྱང་།"), "the catalogue's introduction is Bhoti");
    assert.ok(!forms.includes("Feedback forms for the mentorship cycle"));
    // A form with no title of its own is named from its kind and audience.
    assert.ok(forms.includes("གཞི་རྩ — ལམ་སྟོན་པ།"), "an untitled baseline is named in Bhoti");
    assert.ok(!forms.includes("Baseline — Mentor"));
  });
});

test("the runner's server-side refusal is in the submitter's language", { skip }, async () => {
  await withWorld("i18nsubmit", async (w) => {
    const f = await w.form("baseline", "mentor", { fields: [{ name: "summary", label: "Summary", kind: "text", required: true }] });
    const { submitFormAction } = await import(`${APP}/forms/[slug]/page.tsx`);
    signIn(w.mentor);
    const r = await inLocale("hi", () =>
      outcome(() => submitFormAction(formData({ __formId: f.id, __slug: f.slug, __pairingId: w.pairingA, summary: "" }))),
    );
    assert.equal(r.kind, "redirect", describe(r));
    const detail = new URL((r as { to: string }).to, "http://x").searchParams.get("detail") ?? "";
    assert.equal(detail, "Summary आवश्यक है।");
  });
});

test("an inbox row about a meeting is in its recipient's language, date included", { skip }, async () => {
  await withWorld("i18nnote", async (w) => {
    await w.q(`INSERT INTO user_prefs (user_id, ui_language) VALUES ($1, 'hi')`, [w.teacherA.id]);
    const { logMeetingAction } = await import(`${APP}/mentorship/[pairingId]/actions.ts`);
    signIn(w.mentor);
    // The mentor works in English; the mentee reads Hindi.
    const r = await outcome(() => logMeetingAction(formData({ pairingId: w.pairingA, scheduledAt: "2026-10-02T10:30" })));
    assert.equal(r.kind, "redirect", describe(r));
    const [row] = await w.q<{ subject: string }>(`SELECT subject FROM notifications WHERE user_id = $1`, [w.teacherA.id]);
    assert.ok(row, "the mentee is told");
    assert.match(row.subject, /मेंटरशिप बैठक दर्ज की गई$/);
    assert.doesNotMatch(row.subject, /A mentorship meeting|Oct|Fri/, "nor is the date English");
  });
});
