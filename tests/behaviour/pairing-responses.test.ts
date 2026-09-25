// Reading submitted mentorship feedback, executed through the real pages.
//
// ── F54: SUBMITTED FEEDBACK COULD NOT BE READ BY ANYONE ──────────────────────
//
// feedback_responses was read in three places: the runner (pre-filling the
// respondent's OWN previous answers), the /forms ticks and a bare "N/8" on the
// pairing page. No surface showed a mentee's answers to her mentor, or anyone's
// to an administrator, so the quarterly feedback the programme collects could
// only be read with SQL. "View responses" on a closed quarter opened the live,
// editable form. And the thank-you page told every respondent "The
// mentor/mentee on the other side of this pairing will see a summary in their
// inbox" -- nothing ever wrote that notification.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

type Seeded = { w: World; menteeForm: { id: string; slug: string }; mentorForm: { id: string; slug: string } };

async function withResponses(body: (s: Seeded) => Promise<void>) {
  const w = await buildWorld("fresp");
  try {
    const menteeForm = await w.form("baseline", "mentee", {
      title: "Mentee baseline probe",
      fields: [
        { name: "hopes", kind: "textarea", label: "What do you hope to get from mentoring?" },
        { name: "confidence", kind: "likert", label: "Confidence teaching reading" },
        { name: "supports", kind: "checkbox", label: "Supports wanted", options: [{ value: "coteach", label: "Co-teaching" }, { value: "video", label: "Video review" }] },
      ],
    });
    const mentorForm = await w.form("baseline", "mentor", {
      title: "Mentor baseline probe",
      fields: [{ name: "concerns", kind: "textarea", label: "Concerns" }],
    });
    const respond = (formId: string, pairingId: string, who: Person, responses: Record<string, unknown>) =>
      w.q(
        `INSERT INTO feedback_responses (form_id, pairing_id, respondent_user_id, responses) VALUES ($1, $2, $3, $4::jsonb)`,
        [formId, pairingId, who.id, JSON.stringify(responses)],
      );
    await respond(menteeForm.id, w.pairingA, w.teacherA, { hopes: "hope-text-from-mentee-A", confidence: "4", supports: ["coteach", "video"] });
    await respond(mentorForm.id, w.pairingA, w.mentor, { concerns: "concern-text-about-A" });
    await respond(mentorForm.id, w.pairingB, w.mentor, { concerns: "concern-text-about-B" });
    await w.grant(w.mentor.id);
    await w.grant(w.teacherA.id);
    await body({ w, menteeForm, mentorForm });
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function responsesPage(pairingId: string) {
  const { default: PairingResponsesPage } = await import(
    "../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/responses/page.tsx"
  );
  const r = await outcome(() => PairingResponsesPage({ params: Promise.resolve({ pairingId }) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value));
}

test("a mentor reads what her mentee submitted, and her own answers, read-only", { skip }, async () => {
  await withResponses(async ({ w }) => {
    signIn(w.mentor);
    const html = await responsesPage(w.pairingA);
    assert.match(html, /Mentee baseline probe/);
    assert.match(html, /hope-text-from-mentee-A/);
    assert.match(html, /What do you hope to get from mentoring\?/, "answers are shown against their questions");
    assert.match(html, /Co-teaching, Video review/, "option values are shown by their labels");
    assert.match(html, /concern-text-about-A/);
    assert.match(html, new RegExp(w.teacherA.name), "and says who answered");
    assert.doesNotMatch(html, /concern-text-about-B/, "another pairing's feedback is not this pairing's");
    assert.doesNotMatch(html, /<(textarea|input|form)\b/, "a record, not an editable form");
  });
});

test("a mentee reads her own answers, not her mentor's assessment of her", { skip }, async () => {
  await withResponses(async ({ w }) => {
    signIn(w.teacherA);
    const html = await responsesPage(w.pairingA);
    assert.match(html, /hope-text-from-mentee-A/);
    assert.doesNotMatch(html, /concern-text-about-A/);
  });
});

test("the responses page is the pairing's own: someone else's pairing is not found", { skip }, async () => {
  await withResponses(async ({ w }) => {
    signIn(w.teacherA);
    const { default: PairingResponsesPage } = await import(
      "../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/responses/page.tsx"
    );
    const r = await outcome(() => PairingResponsesPage({ params: Promise.resolve({ pairingId: w.pairingB }) }));
    assert.equal(r.kind, "notFound", describe(r));
  });
});

test("a closed quarter's 'View responses' opens the read-only record, not the live form", { skip }, async () => {
  await withResponses(async ({ w }) => {
    await w.q(`UPDATE mentor_pairings SET current_quarter = 2 WHERE id = $1`, [w.pairingA]);
    signIn(w.mentor);
    const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
    const r = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve({}) }));
    assert.equal(r.kind, "value", describe(r));
    const html = decodeEntities(await render((r as { value: unknown }).value));
    const view = /<a\b[^>]*aria-label="View Q1 responses"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(view, new RegExp(`href="/mentorship/${w.pairingA}/responses`), view || "no View Q1 link");
  });
});

test("the thank-you page promises no inbox summary that nothing sends", { skip }, async () => {
  await withResponses(async ({ w, mentorForm }) => {
    signIn(w.mentor);
    const { default: FormThanksPage } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/thanks/page.tsx");
    const r = await outcome(() =>
      FormThanksPage({ params: Promise.resolve({ slug: mentorForm.slug }), searchParams: Promise.resolve({ pairingId: w.pairingA }) }),
    );
    assert.equal(r.kind, "value", describe(r));
    const html = decodeEntities(await render((r as { value: unknown }).value));
    assert.doesNotMatch(html, /will see a summary in their inbox/);
    assert.match(html, new RegExp(`href="/mentorship/${w.pairingA}/responses"`), "it says where the answers can be read");
  });
});
