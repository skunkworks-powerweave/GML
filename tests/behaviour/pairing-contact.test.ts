// Who the pairing page's contact buttons reach, and who may log a meeting --
// executed through the real pairing page and logMeetingAction.
//
// ── F60 ──────────────────────────────────────────────────────────────────────
//
// The contact target was always the MENTEE: contactPhone = teacher.phone and
// "Hi <mentee>, checking in", with Message -> /inbox?to=<mentee user id>. A
// teacher can open her own pairing, and when she did, WhatsApp opened a chat
// with her own number greeting herself, and Message went to her own inbox --
// which reads only ?filter= and has no messaging at all. Nothing on the page
// let her reach her mentor. "+ Log meeting" was offered to, and accepted from,
// the mentee as well (the page itself says "Mentor logs every contact"), with
// duration as free text ("forty"), and a meeting could never be removed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await buildWorld("contact");
  try {
    for (const p of [w.mentor, w.teacherA]) await w.grant(p.id);
    await body(w);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function pairingHtml(who: Person, pairingId: string) {
  signIn(who);
  const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
  const r = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId }), searchParams: Promise.resolve({}) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value));
}

const waLink = (html: string) => /href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)?.[1] ?? null;

test("the mentee's WhatsApp button reaches her mentor, not herself", { skip }, async () => {
  await withWorld(async (w) => {
    const wa = waLink(await pairingHtml(w.teacherA, w.pairingA));
    assert.ok(wa, "a WhatsApp link to the mentor");
    assert.match(wa!, /^https:\/\/wa\.me\/919000000009\?/, "the mentor's number (+91 9000000009)");
    assert.match(decodeURIComponent(wa!), new RegExp(`Hi ${w.mentor.name}`));
  });
});

test("the mentor's WhatsApp button still reaches the mentee", { skip }, async () => {
  await withWorld(async (w) => {
    const wa = waLink(await pairingHtml(w.mentor, w.pairingA));
    assert.match(wa ?? "", /^https:\/\/wa\.me\/919000000001\?/);
  });
});

test("no 'Message' button points at an inbox that has no messaging", { skip }, async () => {
  await withWorld(async (w) => {
    for (const who of [w.mentor, w.teacherA]) {
      const html = await pairingHtml(who, w.pairingA);
      assert.doesNotMatch(html, /\/inbox\?to=/, who.role);
    }
  });
});

async function logMeeting(who: Person, fields: Record<string, string>) {
  signIn(who);
  const { logMeetingAction } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts");
  return outcome(() => logMeetingAction(formData(fields)));
}

test("a mentee is not offered, and cannot post, a meeting log", { skip }, async () => {
  await withWorld(async (w) => {
    assert.doesNotMatch(await pairingHtml(w.teacherA, w.pairingA), /Log a new meeting/);
    const r = await logMeeting(w.teacherA, { pairingId: w.pairingA, scheduledAt: "2026-09-20T10:00", durationMin: "30" });
    assert.equal(r.kind, "redirect", describe(r));
    const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM mentor_meetings WHERE pairing_id = $1`, [w.pairingA]);
    assert.equal(n, 0);
  });
});

test("a meeting's duration is a whole number of minutes", { skip }, async () => {
  await withWorld(async (w) => {
    const r = await logMeeting(w.mentor, { pairingId: w.pairingA, scheduledAt: "2026-09-20T10:00", durationMin: "forty" });
    assert.deepEqual(r, { kind: "redirect", to: `/mentorship/${w.pairingA}?logMeeting=1&error=invalid_duration` });
    const ok = await logMeeting(w.mentor, { pairingId: w.pairingA, scheduledAt: "2026-09-20T10:00", durationMin: "40" });
    assert.equal(ok.kind, "redirect", describe(ok));
    const rows = await w.q<{ duration_min: string }>(`SELECT duration_min FROM mentor_meetings WHERE pairing_id = $1`, [w.pairingA]);
    assert.deepEqual(rows.map((r) => r.duration_min), ["40"]);
  });
});
