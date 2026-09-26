// A pairing's final (Q4) form tells the people who act on it -- executed
// through the real submit action and the real /inbox.
//
// ── W3-33 (F54 remainder) ────────────────────────────────────────────────────
//
// The final form is the event that makes a pairing ready for an administrator
// to close (completePairingAction; the form itself advances nothing), and
// nothing said it had happened: submitFormAction wrote the response and an
// audit row, and no notification. The pairing sat active at Q4 until an
// administrator happened to open it, and the other party was not told either.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

const FIELDS = { fields: [{ name: "notes", kind: "textarea", label: "Notes" }] };

type Form = { id: string; slug: string };
type Forms = { mentorFinal: Form; menteeFinal: Form; mentorBaseline: Form; endline: Form };

async function withForms(body: (w: World, f: Forms) => Promise<void>) {
  const w = await buildWorld("finaln");
  try {
    const v = { version: `zzz-${w.T}` };
    const mentorFinal = await w.form("final", "mentor", { title: "Mentor final", ...FIELDS }, v);
    const menteeFinal = await w.form("final", "mentee", { title: "Mentee final", ...FIELDS }, v);
    const mentorBaseline = await w.form("baseline", "mentor", { title: "Mentor baseline", ...FIELDS }, v);
    // The Endline survey borrows kind 'final' and is told apart by its
    // purpose (lib/forms/quarterly.ts): it is not a pairing's final form.
    const endline = await w.form("final", "mentee", { title: "Endline survey", purpose: "endline_survey", ...FIELDS }, { version: `yyy-${w.T}` });
    await w.q(`UPDATE mentor_pairings SET current_quarter = 4 WHERE id = $1`, [w.pairingA]);
    for (const p of [w.mentor, w.teacherA, w.admin]) await w.grant(p.id);
    await body(w, { mentorFinal, menteeFinal, mentorBaseline, endline });
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function submitAs(who: Person, form: Form, pairingId: string, notes = `by ${who.role}`) {
  signIn(who);
  const { submitFormAction } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");
  const r = await outcome(() => submitFormAction(formData({ __formId: form.id, __slug: form.slug, __pairingId: pairingId, notes })));
  assert.equal(r.kind, "redirect", describe(r));
  assert.ok((r as { to: string }).to.includes("/thanks"), (r as { to: string }).to);
}

const told = (w: World, userId: string) =>
  w.q<{ subject: string; body: string | null; entity_type: string; entity_id: string }>(
    `SELECT subject, body, entity_type, entity_id FROM notifications
      WHERE user_id = $1 AND kind = 'pairing.final_submitted' AND entity_id = $2`,
    [userId, w.pairingA],
  );

async function inboxAs(who: Person): Promise<string> {
  const { default: InboxPage } = await import("../../apps/web/src/app/(authenticated)/inbox/page.tsx");
  signIn(who);
  const r = await outcome(() => InboxPage({ searchParams: Promise.resolve({}) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value));
}

test("the mentor's final form tells the programme admin and the mentee, not the mentor", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.mentor, f.mentorFinal, w.pairingA, "final-notes-about-the-mentee");
    const forAdmin = await told(w, w.admin.id);
    const forMentee = await told(w, w.teacherA.id);
    assert.equal(forAdmin.length, 1, "the administrator who closes the pairing is told");
    assert.equal(forMentee.length, 1, "the other party is told");
    assert.deepEqual(await told(w, w.mentor.id), [], "not the mentor who sent it");
    assert.equal(forAdmin[0]!.entity_type, "mentor_pairing", "the notice opens the pairing");

    // /inbox has no section gate: no names, no answers.
    for (const row of [...forAdmin, ...forMentee]) {
      const text = `${row.subject}\n${row.body ?? ""}`;
      assert.ok(!text.includes("final-notes-about-the-mentee"), text);
      for (const p of [w.mentor, w.teacherA]) assert.ok(!text.includes(p.name), `no ${p.name} in: ${text}`);
    }

    // Shown under the database's own settings, not only written.
    const inbox = await inboxAs(w.admin);
    assert.ok(inbox.includes(forAdmin[0]!.subject), `the admin's inbox shows "${forAdmin[0]!.subject}"`);
  });
});

test("the mentee's final form tells the mentor and the programme admin", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.teacherA, f.menteeFinal, w.pairingA);
    assert.equal((await told(w, w.mentor.id)).length, 1);
    assert.equal((await told(w, w.admin.id)).length, 1);
    assert.deepEqual(await told(w, w.teacherA.id), []);
  });
});

test("sending the final form again tells nobody a second time", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.mentor, f.mentorFinal, w.pairingA);
    await submitAs(w.mentor, f.mentorFinal, w.pairingA, "corrected");
    assert.equal((await told(w, w.admin.id)).length, 1);
    assert.equal((await told(w, w.teacherA.id)).length, 1);
  });
});

test("an earlier quarter's form and the Endline survey are not a final form", { skip }, async () => {
  await withForms(async (w, f) => {
    await submitAs(w.mentor, f.mentorBaseline, w.pairingA);
    await submitAs(w.teacherA, f.endline, w.pairingA);
    assert.deepEqual(await told(w, w.admin.id), []);
    assert.deepEqual(await told(w, w.mentor.id), []);
  });
});
