// A small observation programme, COMMITTED, for tests that execute the real
// server actions and pages (./_server-actions.ts). Those run on the app's own
// @gml/db pool, which cannot see a test's open transaction, so the rows have
// to be real -- and every one of them is removed again by `cleanup()`.
//
// Codes are tagged and never start with "OBS-2026-0": purge_demo_data.ts
// treats that prefix as demo data, and seed-after-purge.test.ts runs the purge
// against the same database, possibly at the same moment.
//
//   school S; users: admin (programme_admin), teacher (with a teachers row),
//   mentor (mentors row, ACTIVE pairing with the teacher), observer, and a
//   second observer who is not on any cycle.

import type { Client } from "pg";
import { connect, tag } from "./_harness.js";

export type WorldUser = { id: string; role: string; name: string; email: string };

export type ObservationWorld = {
  T: string;
  c: Client;
  schoolId: string;
  admin: WorldUser;
  teacher: WorldUser;
  mentor: WorldUser;
  observer: WorldUser;
  otherObserver: WorldUser;
  teacherId: string;
  mentorId: string;
  pairingId: string;
  /** A new cycle for the world's teacher, observed by the world's observer. */
  cycle: (opts?: { status?: string; observerId?: string | null; code?: string; scheduledAt?: string | null }) => Promise<{ id: string; code: string }>;
  /** A section grant (observation unless named), valid for 8 hours. */
  grant: (userId: string, slug?: "observation" | "mentorship") => Promise<void>;
  cleanup: () => Promise<void>;
};

export async function observationWorld(prefix = "obsw"): Promise<ObservationWorld> {
  const c = await connect();
  const T = tag(prefix);
  const one = async (q: string, p: unknown[]): Promise<string> => (await c.query(q, p)).rows[0].id as string;

  const districtId = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`District ${T}`, T.slice(-12)]);
  const zoneId = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [districtId, `Zone ${T}`]);
  const schoolId = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [zoneId, `School ${T}`, T.slice(-12)]);

  const userIds: string[] = [];
  const user = async (label: string, role: string): Promise<WorldUser> => {
    const name = `${label} ${T}`;
    const email = `${label}.${T}@example.test`;
    const id = await one(
      `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, $3::role) RETURNING id`,
      [email, name, role],
    );
    userIds.push(id);
    return { id, role, name, email };
  };
  const admin = await user("Admin", "programme_admin");
  const teacher = await user("Teacher", "teacher");
  const mentor = await user("Mentor", "mentor");
  const observer = await user("Observer", "observer");
  const otherObserver = await user("OtherObserver", "observer");

  const teacherId = await one(`INSERT INTO teachers (user_id, school_id, full_name) VALUES ($1, $2, $3) RETURNING id`, [
    teacher.id,
    schoolId,
    `Teacher Row ${T}`,
  ]);
  const mentorId = await one(`INSERT INTO mentors (user_id, name, base_location) VALUES ($1, $2, 'Leh') RETURNING id`, [
    mentor.id,
    `Mentor Row ${T}`,
  ]);
  // As /admin/data creates one: current_quarter NULL (the pairing page reads
  // that as Q1) and no meetings yet.
  const pairingId = await one(
    `INSERT INTO mentor_pairings (mentor_id, teacher_id, status, started_at)
     VALUES ($1, $2, 'active', now() - interval '30 days') RETURNING id`,
    [mentorId, teacherId],
  );

  let n = 0;
  const cycle: ObservationWorld["cycle"] = async (opts = {}) => {
    n += 1;
    const code = opts.code ?? `${T}-C${n}`;
    const id = await one(
      `INSERT INTO observation_cycles (code, teacher_id, observer_id, kind, status, topic, scheduled_at)
       VALUES ($1, $2, $3, 'evaluative', $4::observation_status, 'Fractions', $5) RETURNING id`,
      [
        code,
        teacherId,
        opts.observerId === undefined ? observer.id : opts.observerId,
        opts.status ?? "nominated",
        opts.scheduledAt === undefined ? new Date().toISOString() : opts.scheduledAt,
      ],
    );
    return { id, code };
  };

  const grant: ObservationWorld["grant"] = async (userId, slug = "observation") => {
    await c.query(
      `INSERT INTO section_gate_grants (user_id, gate_slug, granted_at, expires_at)
       VALUES ($1, $2::section_gate_slug, now(), now() + interval '8 hours')`,
      [userId, slug],
    );
  };

  const cleanup = async () => {
    try {
      // Cycles first (their forms and evidence cascade); anything a test hung
      // on a cycle -- a video, its file -- is the test's to remove.
      await c.query(`DELETE FROM observation_cycles WHERE teacher_id = $1`, [teacherId]);
      await c.query(`DELETE FROM section_gate_grants WHERE user_id = ANY($1::uuid[])`, [userIds]);
      await c.query(`DELETE FROM mentor_pairings WHERE mentor_id = $1 OR teacher_id = $2`, [mentorId, teacherId]);
      await c.query(`DELETE FROM mentors WHERE id = $1`, [mentorId]);
      await c.query(`DELETE FROM teachers WHERE id = $1`, [teacherId]);
      // notifications cascade with their user.
      await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      await c.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
      await c.query(`DELETE FROM zones WHERE id = $1`, [zoneId]);
      await c.query(`DELETE FROM districts WHERE id = $1`, [districtId]);
    } finally {
      await c.end().catch(() => undefined);
    }
  };

  return { T, c, schoolId, admin, teacher, mentor, observer, otherObserver, teacherId, mentorId, pairingId, cycle, grant, cleanup };
}
