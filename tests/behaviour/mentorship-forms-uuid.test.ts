// Malformed and unknown ids on the mentorship, forms and inbox surfaces answer
// 400/404, never a Postgres error as HTTP 500. Executed through the real route
// handlers and pages.
//
// ── F30 ──────────────────────────────────────────────────────────────────────
//
// /api/form-drafts/[id] passed the raw id into a uuid column: GET, PUT and
// DELETE of /api/form-drafts/not-a-uuid raised 22P02 and answered 500, and a
// PUT for a well-formed but unknown template or cycle id was a foreign-key
// violation and another 500. The form runner did the same with ?pairingId=
// (a link truncated by WhatsApp by one character was a 500), and a foreign
// pairing id rendered the whole fillable form that then 404'd on submit.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type World } from "./_mentorship.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const ZERO = "00000000-0000-4000-8000-000000000000";

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await buildWorld("uuid30");
  try {
    await w.grant(w.teacherA.id);
    signIn(w.teacherA);
    await body(w);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function drafts() {
  return import("../../apps/web/src/app/api/form-drafts/[id]/route.ts");
}

const req = (id: string, scope: string, init?: RequestInit) =>
  new Request(`http://app.test/api/form-drafts/${id}?scope=${scope}`, init);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const putInit = { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ responses: { a: "b" } }) };

test("a malformed draft id is 400 invalid_id on every method", { skip }, async () => {
  await withWorld(async () => {
    const { GET, PUT, DELETE } = await drafts();
    for (const scope of ["template", "cycle"]) {
      for (const [name, call] of [
        ["GET", () => GET(req("not-a-uuid", scope), ctx("not-a-uuid"))],
        ["PUT", () => PUT(req("not-a-uuid", scope, putInit), ctx("not-a-uuid"))],
        ["DELETE", () => DELETE(req("not-a-uuid", scope, { method: "DELETE" }), ctx("not-a-uuid"))],
      ] as const) {
        const r = await outcome(call);
        assert.equal(r.kind, "value", `${name} ${scope}: ${describe(r)}`);
        const res = (r as { value: Response }).value;
        assert.equal(res.status, 400, `${name} ${scope}`);
        assert.equal(((await res.json()) as { error: string }).error, "invalid_id");
      }
    }
  });
});

test("a draft for a form or cycle that does not exist is 404, not a foreign-key 500", { skip }, async () => {
  await withWorld(async (w) => {
    const { PUT } = await drafts();
    for (const scope of ["template", "cycle"]) {
      const r = await outcome(() => PUT(req(ZERO, scope, putInit), ctx(ZERO)));
      assert.equal(r.kind, "value", `${scope}: ${describe(r)}`);
      assert.equal((r as { value: Response }).value.status, 404, scope);
    }
    const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM form_drafts WHERE user_id = $1`, [w.teacherA.id]);
    assert.equal(n, 0);
  });
});

test("the runner, the pairing page and its responses page 404 a malformed or foreign pairing id", { skip }, async () => {
  await withWorld(async (w) => {
    const form = await w.form("baseline", "mentee", { title: "Uuid probe", fields: [{ name: "a", kind: "text" }] });
    const { default: FormRunnerPage } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
    const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
    const { default: PairingResponsesPage } = await import(
      "../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/responses/page.tsx"
    );
    const truncated = w.pairingA.slice(0, -1);
    for (const pairingId of ["not-a-uuid", truncated, w.pairingB]) {
      const runner = await outcome(() => FormRunnerPage({ params: Promise.resolve({ slug: form.slug }), searchParams: Promise.resolve({ pairingId }) }));
      assert.equal(runner.kind, "notFound", `runner ${pairingId}: ${describe(runner)}`);
      const page = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId }), searchParams: Promise.resolve({}) }));
      assert.equal(page.kind, "notFound", `pairing ${pairingId}: ${describe(page)}`);
      const responses = await outcome(() => PairingResponsesPage({ params: Promise.resolve({ pairingId }) }));
      assert.equal(responses.kind, "notFound", `responses ${pairingId}: ${describe(responses)}`);
    }
  });
});

// The submit action's hidden __formId went straight into eq(feedbackForms.id,
// ...): a tampered or truncated value was a Postgres 22P02 and an HTTP 500.
test("a malformed form id on submit goes back to /forms with invalid_form_submit, not a 500", { skip }, async () => {
  await withWorld(async (w) => {
    const form = await w.form("baseline", "mentee", { title: "Uuid probe", fields: [{ name: "a", kind: "text" }] });
    const { submitFormAction } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
    for (const formId of ["not-a-uuid", form.id.slice(0, -1)]) {
      const r = await outcome(() => submitFormAction(formData({ __formId: formId, __slug: form.slug, __pairingId: w.pairingA, a: "x" })));
      assert.deepEqual(r, { kind: "redirect", to: "/forms?error=invalid_form_submit" }, `${formId}: ${describe(r)}`);
    }
    const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM feedback_responses WHERE pairing_id = $1`, [w.pairingA]);
    assert.equal(n, 0);
  });
});
