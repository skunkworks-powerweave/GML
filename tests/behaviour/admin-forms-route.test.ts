// PUT /api/admin/forms/[id] and what it leaves the runner able to open,
// executed through the real route handler and the real runner page.
//
// ── F94: EDITING A FORM COULD MAKE IT UNREACHABLE ────────────────────────────
//
// The route bumps the version in place, and bumpVersion() turned any version
// that was not `N` or `N.M` into `${prev}+1`. Two seeded forms have such
// versions -- "schoolvisit-1" and "endline-1" -- so the first time an
// administrator fixed a typo in either, it became "endline-1+1". The
// catalogue then linked /forms/final-mentee-endline-1+1, the runner received
// the segment still percent-encoded ("endline-1%2B1"), its (kind, audience,
// version) lookup never matched, and every mentee got "Form not found". There
// was no way back short of SQL.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, outcome, signIn, type World } from "./_mentorship.js";
import { render } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const URL_SAFE = /^[A-Za-z0-9._-]+$/;

test("F94: bumpVersion increments the trailing number and never leaves the URL-safe alphabet", async () => {
  const { bumpVersion } = await import("../../apps/web/src/app/api/admin/forms/[id]/route.ts");
  const cases: Array<[string, string]> = [
    ["1", "2"],
    ["9", "10"],
    ["1.0", "1.1"],
    ["2.7", "2.8"],
    ["endline-1", "endline-2"],
    ["schoolvisit-1", "schoolvisit-2"],
    ["draft-Q2", "draft-Q3"],
    ["v2", "v3"],
    ["draft", "draft-2"],
  ];
  for (const [prev, next] of cases) {
    assert.equal(bumpVersion(prev), next, prev);
    assert.match(bumpVersion(prev), URL_SAFE);
  }
});

async function putSchema(id: string, body: string) {
  const { PUT } = await import("../../apps/web/src/app/api/admin/forms/[id]/route.ts");
  return PUT(new Request(`http://app.test/api/admin/forms/${id}`, { method: "PUT", body }), {
    params: Promise.resolve({ id }),
  });
}

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await buildWorld("admforms");
  try {
    await body(w);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

/** The runner, fed the slug the way Next hands over a path segment: still percent-encoded. */
async function openRunner(slug: string, pairingId: string) {
  const { default: FormRunnerPage } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
  const r = await outcome(() =>
    FormRunnerPage({ params: Promise.resolve({ slug: encodeURIComponent(slug) }), searchParams: Promise.resolve({ pairingId }) }),
  );
  assert.equal(r.kind, "value", describe(r));
  return render((r as { value: unknown }).value);
}

test("F94: a form already stranded at a '+' version opens again", { skip }, async () => {
  // The rows the old bump produced are still in production databases.
  await withWorld(async (w) => {
    const title = `Stranded probe ${w.T}`;
    const form = await w.form("final", "mentee", { title, fields: [{ name: "notes", kind: "textarea", label: "Notes" }] }, { version: `endline-${w.T}-1+1` });
    await w.grant(w.teacherA.id);
    signIn(w.teacherA);
    const html = await openRunner(form.slug, w.pairingA);
    assert.doesNotMatch(html, /No active form matches this URL/);
    assert.match(html, new RegExp(title));
  });
});

test("F94: an edited endline-style form is still reachable by its new slug", { skip }, async () => {
  await withWorld(async (w) => {
    const title = `Endline probe ${w.T}`;
    const form = await w.form("final", "mentee", { title, fields: [{ name: "notes", kind: "textarea", label: "Notes" }] }, { version: `endline-${w.T}-1` });

    signIn(w.admin);
    const res = await putSchema(form.id, JSON.stringify({ title, fields: [{ name: "notes", kind: "textarea", label: "Notes (typo fixed)" }] }));
    assert.equal(res.status, 200, await res.clone().text());
    const { version } = (await res.json()) as { version: string };
    assert.equal(version, `endline-${w.T}-2`);

    await w.grant(w.teacherA.id);
    signIn(w.teacherA);
    const html = await openRunner(`final-mentee-${version}`, w.pairingA);
    assert.doesNotMatch(html, /No active form matches this URL/);
    assert.match(html, /Notes \(typo fixed\)/);
  });
});
