// Form drafts belong to ONE PAIRING, executed through the real route handler,
// runner page and submit action.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// A mentor answers each quarterly form once PER MENTEE (the seed gives both
// mentors five), but form_drafts was unique on (user_id, template_id) and the
// runner autosaved with draftKey={{ templateId }}: no pairing anywhere. So
//   - half-written answers about mentee A loaded, under "Draft loaded", into
//     the same form for mentee B, and submitting there filed A's content
//     against B's pairing;
//   - the draft outranked B's own prior response, so "View responses" showed
//     someone else's words;
//   - submitting ANY pairing's form deleted the one shared draft, silently
//     discarding the unfinished form about every other mentee.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type World } from "./_mentorship.js";
import { render } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const SCHEMA = { title: "Draft scope form", fields: [{ name: "notes", kind: "textarea", label: "Notes" }] };

async function routes() {
  return import("../../apps/web/src/app/api/form-drafts/[id]/route.ts");
}

function draftUrl(templateId: string, pairingId?: string) {
  const u = new URL(`http://app.test/api/form-drafts/${templateId}`);
  u.searchParams.set("scope", "template");
  if (pairingId) u.searchParams.set("pairingId", pairingId);
  return u.toString();
}

async function putDraft(templateId: string, pairingId: string, responses: Record<string, unknown>) {
  const { PUT } = await routes();
  return PUT(
    new Request(draftUrl(templateId, pairingId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responses }),
    }),
    { params: Promise.resolve({ id: templateId }) },
  );
}

async function getDraft(templateId: string, pairingId?: string) {
  const { GET } = await routes();
  return GET(new Request(draftUrl(templateId, pairingId)), { params: Promise.resolve({ id: templateId }) });
}

async function withMentor(body: (w: World, form: { id: string; slug: string }) => Promise<void>) {
  const w = await buildWorld("drafts");
  try {
    const form = await w.form("baseline", "mentor", SCHEMA);
    await w.grant(w.mentor.id);
    signIn(w.mentor);
    await body(w, form);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

test("a draft saved for mentee A is not served for mentee B", { skip }, async () => {
  await withMentor(async (w, form) => {
    const put = await putDraft(form.id, w.pairingA, { notes: "written about mentee A" });
    assert.equal(put.status, 200, await put.clone().text());

    const forB = await getDraft(form.id, w.pairingB);
    assert.equal(forB.status, 404, `B has no draft, but got ${await forB.clone().text()}`);

    const forA = await getDraft(form.id, w.pairingA);
    assert.equal(forA.status, 200);
    assert.equal(((await forA.json()) as { responses: { notes: string } }).responses.notes, "written about mentee A");
  });
});

test("the runner for mentee B does not pre-fill mentee A's draft", { skip }, async () => {
  await withMentor(async (w, form) => {
    assert.equal((await putDraft(form.id, w.pairingA, { notes: "written about mentee A" })).status, 200);
    const { default: FormRunnerPage } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");

    const pageFor = async (pairingId: string) => {
      const r = await outcome(() =>
        FormRunnerPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId }) }),
      );
      assert.equal(r.kind, "value", `runner did not render: ${describe(r)}`);
      return render((r as { value: unknown }).value);
    };

    const htmlB = await pageFor(w.pairingB);
    assert.doesNotMatch(htmlB, /written about mentee A/, "mentee A's answers must not appear in mentee B's form");
    assert.match(htmlB, /No draft yet/);

    const htmlA = await pageFor(w.pairingA);
    assert.match(htmlA, /written about mentee A/);
    assert.match(htmlA, /Draft loaded/);
  });
});

test("submitting mentee B's form keeps the unfinished draft about mentee A", { skip }, async () => {
  await withMentor(async (w, form) => {
    assert.equal((await putDraft(form.id, w.pairingA, { notes: "unfinished, about A" })).status, 200);
    assert.equal((await putDraft(form.id, w.pairingB, { notes: "about B" })).status, 200);
    const { submitFormAction } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");

    const r = await outcome(() =>
      submitFormAction(formData({ __formId: form.id, __slug: form.slug, __pairingId: w.pairingB, notes: "about B" })),
    );
    assert.equal(r.kind, "redirect", describe(r));
    assert.ok((r as { to: string }).to.startsWith(`/forms/${form.slug}/thanks`), (r as { to: string }).to);

    const drafts = await w.q<{ notes: string }>(
      `SELECT responses->>'notes' AS notes FROM form_drafts WHERE user_id = $1 AND template_id = $2`,
      [w.mentor.id, form.id],
    );
    assert.deepEqual(drafts.map((d) => d.notes), ["unfinished, about A"], "only B's own draft is cleared");
  });
});

test("re-saving updates the one draft per pairing, and a form opened without a pairing keeps one draft too", { skip }, async () => {
  await withMentor(async (w, form) => {
    const { PUT } = await routes();
    const putNoPairing = (notes: string) =>
      PUT(
        new Request(draftUrl(form.id), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ responses: { notes } }),
        }),
        { params: Promise.resolve({ id: form.id }) },
      );
    for (const n of ["a1", "a2"]) assert.equal((await putDraft(form.id, w.pairingA, { notes: n })).status, 200);
    // NULLS NOT DISTINCT is what makes the second of these an update, not a
    // second row the runner would then pick between at random.
    for (const n of ["p1", "p2"]) assert.equal((await putNoPairing(n)).status, 200);
    const rows = await w.q<{ pairing_id: string | null; notes: string }>(
      `SELECT pairing_id, responses->>'notes' AS notes FROM form_drafts WHERE user_id = $1 ORDER BY notes`,
      [w.mentor.id],
    );
    assert.deepEqual(rows, [
      { pairing_id: w.pairingA, notes: "a2" },
      { pairing_id: null, notes: "p2" },
    ]);
  });
});

test("a draft about a pairing needs the mentorship section, and the caller's own pairing", { skip }, async () => {
  await withMentor(async (w, form) => {
    await w.q(`DELETE FROM section_gate_grants WHERE user_id = $1`, [w.mentor.id]);
    assert.equal((await putDraft(form.id, w.pairingA, { notes: "x" })).status, 403, "section locked");
    assert.equal((await getDraft(form.id, w.pairingA)).status, 403);

    // Teacher A may keep a draft about her own pairing, never about B's.
    const menteeForm = await w.form("baseline", "mentee", SCHEMA);
    await w.grant(w.teacherA.id);
    signIn(w.teacherA);
    assert.equal((await putDraft(menteeForm.id, w.pairingA, { notes: "mine" })).status, 200);
    assert.equal((await putDraft(menteeForm.id, w.pairingB, { notes: "not mine" })).status, 404);
    const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM form_drafts WHERE pairing_id = $1`, [w.pairingB]);
    assert.equal(n, 0);
  });
});

// F58 (review): a copy of unsaved answers kept on the device is restored only
// when it is newer than what the server handed the page, and only for the
// user who typed it. The runners can compare only what the page tells them:
// the time the draft (or, without one, the prior answer) was written, and who
// is signed in.
test("the runner tells the renderer who is signed in and when the server wrote what it starts from", { skip }, async () => {
  await withMentor(async (w, form) => {
    const { default: FormRunnerPage } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
    const rendererProps = async (pairingId: string) => {
      const r = await outcome(() =>
        FormRunnerPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId }) }),
      );
      assert.equal(r.kind, "value", describe(r));
      const found: Array<Record<string, unknown>> = [];
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object" || !("props" in n)) return;
        const el = n as { type: unknown; props: Record<string, unknown> };
        if (typeof el.type === "function" && /^(FormRenderer|MobileFormRunner)$/.test((el.type as { name: string }).name)) {
          found.push(el.props);
        }
        walk(el.props.children);
      };
      walk((r as { value: unknown }).value);
      assert.equal(found.length, 1, "one renderer");
      return found[0]!;
    };

    // A draft: its updatedAt.
    assert.equal((await putDraft(form.id, w.pairingA, { notes: "draft" })).status, 200);
    const [d] = await w.q<{ updated_at: Date }>(
      `SELECT updated_at FROM form_drafts WHERE user_id = $1 AND pairing_id = $2`,
      [w.mentor.id, w.pairingA],
    );
    const withDraft = await rendererProps(w.pairingA);
    assert.equal(withDraft.userId, w.mentor.id);
    assert.equal(withDraft.serverSavedAt, new Date(d!.updated_at).getTime());

    // No draft, a prior answer: its submittedAt.
    await w.q(
      `INSERT INTO feedback_responses (form_id, pairing_id, respondent_user_id, responses) VALUES ($1, $2, $3, '{"notes":"sent"}'::jsonb)`,
      [form.id, w.pairingB, w.mentor.id],
    );
    const [p] = await w.q<{ submitted_at: Date }>(`SELECT submitted_at FROM feedback_responses WHERE pairing_id = $1`, [w.pairingB]);
    assert.equal((await rendererProps(w.pairingB)).serverSavedAt, new Date(p!.submitted_at).getTime());
  });
});
