// The mentorship, forms and inbox pages lay out at PHONE width -- executed on
// their real markup (F11).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The phone shell renders the same page JSX as the desktop shell, and the
// pairing page -- the one "most meetings are logged from", on a phone -- set
// its columns as inline styles that hold at every width: the body was
// gridTemplateColumns "1.5fr 1fr", the quarter strip "repeat(4, 1fr)" and the
// add-commitment row "1fr 90px 70px auto". At 375 px the page was ~650 px
// wide: Q3 and Q4 and the commitment inputs sat off the right edge, and
// Chrome widened the layout viewport, which put the fixed bottom tab bar --
// the only navigation on a phone -- off screen. The pairings list tiled cards
// at no less than 320 px, wider than a phone's content box, and the phone
// form's star rating was a row of five 56 px buttons that could not wrap.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// Each REAL page is rendered as a phone user (gml-device=mobile) against
// Postgres, and ./_phone-layout.ts resolves every element's layout at 360 px
// from its inline style, globals.css and the app's own Tailwind build (that
// resolver is checked against known markup in ui-phone-layout.test.ts).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, withAppRouter, request } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { phoneLayoutIssues, templateAt, parseMarkup, walk, PHONE_WIDTH } from "./_phone-layout.js";

const skip = needsDatabase();
after(closeAppPool);

const APP = "../../apps/web/src/app/(authenticated)";

/** Render a page as `who` on a phone (or on a desktop), failing loudly on a redirect or 404. */
async function asDevice(who: Person, device: "mobile" | "desktop", run: () => Promise<unknown>): Promise<string> {
  signIn(who);
  request.cookies = { "gml-device": device };
  try {
    const r = await outcome(run);
    assert.equal(r.kind, "value", describe(r));
    return await render(withAppRouter((r as { value: unknown }).value));
  } finally {
    request.cookies = {};
  }
}
const asPhone = (who: Person, run: () => Promise<unknown>) => asDevice(who, "mobile", run);

function noIssues(issues: string[], where: string) {
  assert.deepEqual(issues, [], `${where} at ${PHONE_WIDTH}px:\n  ${issues.join("\n  ")}`);
}

/** Track count of a resolved template ("minmax(0,1.5fr) minmax(0,1fr)" -> 2). */
function columns(template: string): number {
  const m = template.match(/^repeat\((\d+),/);
  if (m) return Number(m[1]);
  return template.split(/\s+(?![^(]*\))/).filter(Boolean).length;
}

async function withWorld(prefix: string, body: (w: World) => Promise<void>) {
  const w = await buildWorld(prefix);
  try {
    for (const p of [w.admin, w.mentor, w.teacherA, w.teacherB]) await w.grant(p.id);
    await body(w);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

// ── /mentorship/[pairingId] ──────────────────────────────────────────────────

test("a pairing page fits a phone: the quarters, the body and the commitment row stack; a desktop keeps its columns", { skip }, async () => {
  await withWorld("phonepair", async (w) => {
    // Content in every part of the page: a commitment whose text is one long
    // unbroken word (a pasted link), a meeting with notes, and the open
    // "Log meeting" form.
    const long = `https://example.test/${"x".repeat(80)}`;
    await w.q(`UPDATE mentor_pairings SET commitments = $2::jsonb, concept_note = 'Build a reading corner' WHERE id = $1`, [
      w.pairingA,
      JSON.stringify([{ id: "c1", text: long, who: "mentee", due: "Wk 8", done: false }]),
    ]);
    await w.q(`INSERT INTO mentor_meetings (pairing_id, scheduled_at, duration_min, notes) VALUES ($1, now() + interval '2 days', 40, $2)`, [
      w.pairingA,
      `Discussed ${long}`,
    ]);

    const { default: PairingPage } = await import(`${APP}/mentorship/[pairingId]/page.tsx`);
    const page = (sp: Record<string, string>) => () =>
      PairingPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve(sp) });

    const failures: string[] = [];
    for (const [who, sp, label] of [
      [w.mentor, { logMeeting: "1" }, "mentor, logging a meeting"],
      [w.teacherA, {}, "mentee"],
      [w.admin, {}, "administrator"],
    ] as const) {
      const html = await asPhone(who, page(sp));
      assert.match(html, /name="text"/, `${label}: the add-commitment row is on the page`);
      if (who === w.mentor) assert.match(html, /name="scheduledAt"/, "the Log meeting form is open");
      for (const issue of await phoneLayoutIssues(html)) failures.push(`${label}: ${issue}`);
    }
    noIssues(failures, "/mentorship/[pairingId]");

    // The desktop layout is unchanged: meetings beside feedback, four quarters.
    const desktop = await asDevice(w.mentor, "desktop", page({}));
    const body = await templateAt(desktop, 1280, (e) => (e.attrs.class ?? "").split(" ").includes("page-body"));
    assert.equal(body.length, 1);
    assert.equal(columns(body[0]!), 2, `two columns on a desktop: ${body[0]}`);
    const strip = await templateAt(desktop, 1280, (e) => e.attrs["data-testid"] === "quarter-strip");
    assert.equal(strip.length, 1, "the quarter strip is marked");
    assert.equal(columns(strip[0]!), 4, `four quarters side by side on a desktop: ${strip[0]}`);
  });
});

// ── /mentorship and the responses record ─────────────────────────────────────

test("the pairings list and a pairing's responses fit a phone", { skip }, async () => {
  await withWorld("phonelist", async (w) => {
    const form = await w.form("baseline", "mentor", { title: `Baseline ${w.T}`, fields: [{ name: "q1", label: "Q1", kind: "textarea" }] });
    await w.q(
      `INSERT INTO feedback_responses (form_id, respondent_user_id, pairing_id, responses) VALUES ($1, $2, $3, $4::jsonb)`,
      [form.id, w.mentor.id, w.pairingA, JSON.stringify({ q1: `See https://example.test/${"y".repeat(80)}` })],
    );
    const { default: ListPage } = await import(`${APP}/mentorship/page.tsx`);
    const { default: ResponsesPage } = await import(`${APP}/mentorship/[pairingId]/responses/page.tsx`);
    for (const who of [w.mentor, w.admin]) {
      const list = await asPhone(who, () => ListPage({ searchParams: Promise.resolve({}) }));
      assert.match(list, new RegExp(`href="/mentorship/${w.pairingA}"`), `${who.role}: the pairing is listed`);
      noIssues(await phoneLayoutIssues(list), `/mentorship as ${who.role}`);
    }
    const responses = await asPhone(w.mentor, () => ResponsesPage({ params: Promise.resolve({ pairingId: w.pairingA }) }));
    assert.match(responses, /data-testid="response"/, "the response is shown");
    noIssues(await phoneLayoutIssues(responses), "/mentorship/[pairingId]/responses");
  });
});

// ── /forms, a form on a phone, and its thank-you page ────────────────────────

test("the forms catalogue, the phone form runner and the thank-you page fit a phone", { skip }, async () => {
  await withWorld("phoneform", async (w) => {
    // The rating first, so the runner's first screen is the star row.
    const form = await w.form("baseline", "mentor", {
      title: `Baseline ${w.T}`,
      fields: [
        { name: "overall", label: "Overall", kind: "rating", required: true },
        { name: "notes", label: "Notes", kind: "textarea" },
      ],
    });
    const { default: FormsPage } = await import(`${APP}/forms/page.tsx`);
    // The mentor has two mentees, so each form row lists one link per pairing.
    const catalogue = await asPhone(w.mentor, () => FormsPage({ searchParams: Promise.resolve({}) }));
    assert.match(catalogue, new RegExp(`pairingId=${w.pairingB}`), "one link per pairing");
    noIssues(await phoneLayoutIssues(catalogue), "/forms as mentor");
    noIssues(await phoneLayoutIssues(await asPhone(w.admin, () => FormsPage({ searchParams: Promise.resolve({}) }))), "/forms as admin");

    const { default: RunnerPage } = await import(`${APP}/forms/[slug]/page.tsx`);
    const runner = await asPhone(w.mentor, () =>
      RunnerPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId: w.pairingA }) }),
    );
    assert.match(runner, /data-testid="mobile-rating"/, "the phone runner's first screen is the star row");
    noIssues(await phoneLayoutIssues(runner), "/forms/[slug]");

    const { default: ThanksPage } = await import(`${APP}/forms/[slug]/thanks/page.tsx`);
    const thanks = await asPhone(w.mentor, () =>
      ThanksPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId: w.pairingA }) }),
    );
    noIssues(await phoneLayoutIssues(thanks), "/forms/[slug]/thanks");
    // Two buttons, ~320 px side by side: wider than a 360 px phone's content
    // once "Back to mentorship" is the label. The row has to be allowed to wrap.
    const rows = [...walk(parseMarkup(thanks))].filter(
      (e) => /display:\s*flex/.test(e.attrs.style ?? "") && e.children.filter((c) => c.tag === "a").length >= 2,
    );
    assert.equal(rows.length, 1, "the thank-you page's button row");
    assert.match(rows[0]!.attrs.style ?? "", /flex-wrap:\s*wrap/, "the button row wraps");
  });
});

// ── /inbox ───────────────────────────────────────────────────────────────────

test("the inbox fits a phone", { skip }, async () => {
  await withWorld("phoneinbox", async (w) => {
    await w.q(
      `INSERT INTO notifications (user_id, kind, subject, body, entity_type, entity_id) VALUES
         ($1, 'meeting.scheduled', $2, $3, 'mentor_pairing', $4),
         ($1, 'meeting.scheduled', $2, NULL, NULL, NULL)`,
      [w.teacherA.id, `Meeting ${w.T}`, `A meeting was scheduled ${"z".repeat(90)}`, w.pairingA],
    );
    const { default: InboxPage } = await import(`${APP}/inbox/page.tsx`);
    for (const sp of [{}, { filter: "unread" }]) {
      const html = await asPhone(w.teacherA, () => InboxPage({ searchParams: Promise.resolve(sp) }));
      assert.match(html, new RegExp(`Meeting ${w.T}`), "the notifications are listed");
      noIssues(await phoneLayoutIssues(html), `/inbox ${JSON.stringify(sp)}`);
    }
  });
});
