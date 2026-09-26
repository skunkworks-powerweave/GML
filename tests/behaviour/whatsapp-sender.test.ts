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
import { envelope, route, SECRET, signed, videoMessage, waitFor, withEnv, withWorld, type World } from "./_whatsapp.js";

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
          const [row] = await waitFor(() => w.audits("whatsapp.context.forbidden", id), (r) => r.length >= 1);
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

// F141: mentors and observers have no teacher record, so the only number that
// can attribute their WhatsApp videos is the one on their ACCOUNT. users.phone
// had no writer; /admin/users now records it (setPhoneAction, admin package,
// tests/behaviour/admin-user-phone.test.ts). This pins the WhatsApp half: a
// mentor whose account carries a number is credited, and may attach a
// recording to a meeting of their own pairing.
test("F141: a mentor whose account has a phone is credited and may attach to their pairing's meeting", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
      const digits = "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
      const userId = await one(
        `INSERT INTO users (id, email, name, role, phone) VALUES (gen_random_uuid(), $1, 'Mentor', 'mentor', $2) RETURNING id`,
        [`mentor.${w.T}@example.test`, `+91 ${digits}`],
      );
      const mentorId = await one(`INSERT INTO mentors (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, `Mentor ${w.T}`]);
      const pairingId = await one(`INSERT INTO mentor_pairings (mentor_id, teacher_id) VALUES ($1, $2) RETURNING id`, [
        mentorId,
        w.teacher.teacherId,
      ]);
      const meetingId = await one(`INSERT INTO mentor_meetings (pairing_id, scheduled_at) VALUES ($1, now()) RETURNING id`, [pairingId]);
      try {
        const { sub } = await send(w, `91${digits}`, `MM-${meetingId}`);
        assert.equal(sub.submitted_by_user_id, userId);
        assert.equal(sub.context_type, "mentor_meeting");
        assert.equal(sub.context_id, meetingId);
        // The mentee's cycle is visible to an actively paired mentor, so a
        // mentor may attach an observation recording to it as well.
        assert.equal((await send(w, `91${digits}`, w.cycleCode)).sub.context_id, w.cycleId);
      } finally {
        await w.c.query(`DELETE FROM mentor_meetings WHERE id = $1`, [meetingId]);
        await w.c.query(`DELETE FROM mentor_pairings WHERE id = $1`, [pairingId]);
        await w.c.query(`DELETE FROM mentors WHERE id = $1`, [mentorId]);
        await w.c.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = $1`, [userId]);
        await w.c.query(`DELETE FROM users WHERE id = $1`, [userId]);
      }
    }),
  );
});

/**
 * RTT subjects for a teach-back caption to name: one taught across the
 * programme (so the world's teachers are shown it), one taught only in another
 * district, and a retired one.
 */
async function rttSubjects(w: World) {
  const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
  const district = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`TB ${w.T}`, `T${w.T.slice(-11)}`]);
  // phases.label is varchar(24) and unique; sequence is unique too.
  const phase = await one(`INSERT INTO phases (label, sequence) VALUES ($1, $2) RETURNING id`, [
    `TB ${w.T}`.slice(0, 24),
    3_000_000 + Math.floor(Math.random() * 1e9),
  ]);
  const term = await one(`INSERT INTO terms (phase_id, name, sequence) VALUES ($1, $2, 1) RETURNING id`, [phase, `Term ${w.T}`]);
  const subject = (name: string, o: { districtId?: string; active?: boolean } = {}) =>
    one(`INSERT INTO rtt_subjects (term_id, name, district_id, active) VALUES ($1, $2, $3, $4) RETURNING id`, [
      term,
      `${name} ${w.T}`,
      o.districtId ?? null,
      o.active ?? true,
    ]);
  const shown = await subject("Everywhere");
  const elsewhere = await subject("Elsewhere", { districtId: district });
  const retired = await subject("Retired", { active: false });
  return {
    shown,
    elsewhere,
    retired,
    cleanup: async () => {
      // The world deletes its video rows only after this runs; a teach-back
      // carries no key to its subject (context_id has no FK by design).
      await w.c.query(`DELETE FROM rtt_subjects WHERE term_id = $1`, [term]);
      await w.c.query(`DELETE FROM terms WHERE id = $1`, [term]);
      await w.c.query(`DELETE FROM phases WHERE id = $1`, [phase]);
      await w.c.query(`DELETE FROM districts WHERE id = $1`, [district]);
    },
  };
}

// FR-02: TB-<id> was accepted for any syntactically valid uuid -- the
// "teach_backs surface" its comment deferred to does not exist -- so a
// teach-back sent by WhatsApp was linked to nothing a reviewer could name, and
// no page could give a teacher an id to send. A teach-back is now FOR an RTT
// subject, and the caption the /uploads page gives for one is TB-<subject id>:
// held here to the same check as the direct upload (uploads/context.ts), a
// subject the sender is shown.
test("FR-02: TB-<subject> links a teach-back to the RTT subject it names, for a sender shown that subject", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const s = await rttSubjects(w);
      try {
        const mine = await send(w, w.teacher.phone, `TB-${s.shown}`);
        assert.deepEqual([mine.sub.context_type, mine.sub.context_id], ["teach_back", s.shown]);

        for (const [label, id, action, reason] of [
          ["an id that is no subject", randomUUID(), "whatsapp.context.unmatched", "teach_back.subject_not_found"],
          ["a subject taught in another district", s.elsewhere, "whatsapp.context.forbidden", "teach_back.not_permitted"],
          ["a retired subject", s.retired, "whatsapp.context.forbidden", "teach_back.not_permitted"],
        ] as const) {
          const r = await send(w, w.teacher.phone, `TB-${id}`);
          assert.deepEqual([r.sub.context_type, r.sub.context_id], ["generic", null], `${label}: kept, linked to nothing`);
          const [a] = await waitFor(() => w.audits(action, r.id), (rows) => rows.length >= 1);
          assert.equal((a?.metadata as { reason?: string } | undefined)?.reason, reason, label);
        }
      } finally {
        await s.cleanup();
      }
    }),
  );
});

test("F138: a teach-back needs a registered sender; a stranger's clip is quarantined, not queued for every reviewer", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      // A subject the teacher is shown: TB- names an RTT subject since FR-02
      // (any uuid was accepted before, which this test used to send).
      const s = await rttSubjects(w);
      try {
        const tb = `TB-${s.shown}`;
        assert.equal((await send(w, STRANGER, tb)).sub.context_type, "generic");
        const mine = await send(w, w.teacher.phone, tb);
        assert.equal(mine.sub.context_type, "teach_back", "a registered teacher's own teach-back is accepted, as on the upload path");
        assert.equal(mine.sub.submitted_by_user_id, w.teacher.userId);
      } finally {
        await s.cleanup();
      }
    }),
  );
});
