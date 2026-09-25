// Who may attach a WhatsApp video to what, executed through the webhook.
//
// ── THE DEFECT (F138) ────────────────────────────────────────────────────────
//
// The signature proves Meta delivered the message, not who sent it, and the
// webhook routed purely on the caption: OBS-<code> attached the clip to ANY
// cycle (codes are sequential, OBS-2026-001...), MM-<uuid> to any meeting, and
// TB-<uuid> to the teach-back queue for any syntactically valid uuid. The
// sender was matched to a user and then never compared with the target. Since
// authz grants video access through what a clip is attached to, a stranger's
// clip became visible and playable to that cycle's teacher, observer and
// mentors -- and a teacher who mistyped a code sent her classroom (children's
// faces) to another teacher's mentor and observer.
//
// The direct-upload path already refuses exactly this (uploads/actions.ts,
// assertContextAllowed). These tests hold the WhatsApp path to the same rule,
// using the same visibility predicates lib/authz.ts applies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { needsDatabase } from "./_harness.js";
import { envelope, route, SECRET, settle, signed, videoMessage, withEnv, withWorld, type World } from "./_whatsapp.js";

const skip = needsDatabase();

const CONFIGURED = { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined };

async function send(w: World, from: string, caption: string) {
  const { POST } = await route();
  const id = w.wamid();
  assert.equal((await POST(signed(envelope([videoMessage({ id, from, caption })])))).status, 200);
  const sub = await w.submission(id);
  assert.ok(sub, "the video is still ingested -- refusing it would lose it");
  return { id, sub };
}

/** A mentor paired with the world's teacher, with one meeting, and an observer on the cycle. */
async function people(w: World) {
  const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
  const phone = () => "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
  const observerPhone = phone();
  const observerId = await one(
    `INSERT INTO users (id, email, name, role, phone) VALUES (gen_random_uuid(), $1, 'Observer', 'observer', $2) RETURNING id`,
    [`obs.${w.T}@example.test`, `+91${observerPhone}`],
  );
  await w.c.query(`UPDATE observation_cycles SET observer_id = $1 WHERE id = $2`, [observerId, w.cycleId]);
  const mentorId = await one(`INSERT INTO mentors (name) VALUES ($1) RETURNING id`, [`Mentor ${w.T}`]);
  const pairingId = await one(`INSERT INTO mentor_pairings (mentor_id, teacher_id) VALUES ($1, $2) RETURNING id`, [
    mentorId,
    w.teacher.teacherId,
  ]);
  const meetingId = await one(`INSERT INTO mentor_meetings (pairing_id, scheduled_at) VALUES ($1, now()) RETURNING id`, [pairingId]);
  const cleanup = async () => {
    await w.c.query(`UPDATE observation_cycles SET observer_id = NULL WHERE id = $1`, [w.cycleId]);
    await w.c.query(`DELETE FROM mentor_meetings WHERE id = $1`, [meetingId]);
    await w.c.query(`DELETE FROM mentor_pairings WHERE id = $1`, [pairingId]);
    await w.c.query(`DELETE FROM mentors WHERE id = $1`, [mentorId]);
    await w.c.query(`DELETE FROM users WHERE id = $1`, [observerId]);
  };
  return { observer: { userId: observerId, phone: `91${observerPhone}` }, meetingId, cleanup };
}

const STRANGER = "447700900123"; // matches no user

test("F138: a caption names a target; only someone who may write to it gets the video attached", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const p = await people(w);
      try {
        // Allowed: the cycle's teacher and its observer.
        assert.equal((await send(w, w.teacher.phone, w.cycleCode)).sub.context_id, w.cycleId);
        assert.equal((await send(w, p.observer.phone, w.cycleCode)).sub.context_id, w.cycleId);

        // Refused: a number on file for nobody, and a different teacher.
        for (const from of [STRANGER, w.otherTeacher.phone]) {
          const { id, sub } = await send(w, from, w.cycleCode);
          assert.equal(sub.context_type, "generic", `${from} must not be able to write into another teacher's cycle`);
          assert.equal(sub.context_id, null);
          assert.equal(sub.caption_raw, w.cycleCode, "the caption is kept so an admin can see what was attempted");
          await settle();
          const [row] = await w.audits("whatsapp.context.forbidden", id);
          assert.ok(row, "a refused attachment is a security event and must be audited");
        }

        // The sender is still credited when known, so it is theirs to see.
        const own = await send(w, w.otherTeacher.phone, w.cycleCode);
        assert.equal(own.sub.submitted_by_user_id, w.otherTeacher.userId);

        // Meetings: the pairing's teacher may, another teacher may not.
        assert.equal((await send(w, w.teacher.phone, `MM-${p.meetingId}`)).sub.context_id, p.meetingId);
        assert.equal((await send(w, w.otherTeacher.phone, `MM-${p.meetingId}`)).sub.context_type, "generic");
      } finally {
        await p.cleanup();
      }
    }),
  );
});

test("F138: a teach-back needs a registered sender; a stranger's clip is quarantined, not queued for every reviewer", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const tb = `TB-${randomUUID()}`;
      assert.equal((await send(w, STRANGER, tb)).sub.context_type, "generic");
      const mine = await send(w, w.teacher.phone, tb);
      assert.equal(mine.sub.context_type, "teach_back", "a registered teacher's own teach-back is accepted, as on the upload path");
      assert.equal(mine.sub.submitted_by_user_id, w.teacher.userId);
    }),
  );
});
