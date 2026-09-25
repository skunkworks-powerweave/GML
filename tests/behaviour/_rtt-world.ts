// A small RTT programme, COMMITTED, for tests that render the real /rtt pages
// and call their server actions (./_server-actions.ts). Those run on the app's
// own @gml/db pool, which cannot see a test's open transaction, so the rows
// are real -- and `cleanup()` removes every one of them again, children first
// (the RTT keys are ON DELETE RESTRICT since migration 0031).
//
//   geography: district D with zones Z (the teacher's) and Z2; a second
//              district D2 with zone Y
//   users:     teacher (teachers row at a school in Z), admin
//              (programme_admin), mentor (ACTIVE pairing with the teacher),
//              observer
//   content:   one phase with one term; subjects, modules, lessons, readings,
//              sessions and quizzes are added per test
//
// Every name carries the tag, so a test only ever asserts on its own rows:
// node --test runs the files concurrently against one database.

import { randomInt } from "node:crypto";
import type { Client } from "pg";
import { connect, tag } from "./_harness.js";

export type RttUser = { id: string; role: string; name: string; email: string };

export type RttWorld = {
  T: string;
  c: Client;
  districtId: string;
  zoneId: string;
  zone2Id: string;
  district2Id: string;
  zoneYId: string;
  phaseId: string;
  termId: string;
  teacher: RttUser;
  teacherId: string;
  admin: RttUser;
  mentor: RttUser;
  observer: RttUser;
  /** Another user, for "a different learner" (no teachers row). */
  user: (label: string, role: string) => Promise<RttUser>;
  /** Another teacher: a login and a teachers row at a school in `zoneId` (default Z). */
  addTeacher: (label: string, zoneId?: string) => Promise<{ user: RttUser; teacherId: string }>;
  /** A live section-gate grant (8 hours). */
  grant: (userId: string, slug: "mentorship" | "observation") => Promise<void>;
  /** A subject in the world's term; `districtId` / `zoneId` scope it (migration 0038). */
  subject: (opts?: { name?: string; active?: boolean; districtId?: string; zoneId?: string }) => Promise<string>;
  module: (subjectId: string, sequence: number, title?: string) => Promise<string>;
  lesson: (moduleId: string, sequence: number, title?: string) => Promise<string>;
  reading: (subjectId: string, sequence: number, title?: string) => Promise<string>;
  session: (
    subjectId: string,
    opts: { sequence: number; title?: string; link?: string | null; scheduledAt?: Date | null },
  ) => Promise<string>;
  quiz: (
    subjectId: string,
    opts?: { slug?: string; title?: string; active?: boolean; maxAttempts?: number | null },
  ) => Promise<{ id: string; slug: string }>;
  submission: (quizId: string, userId: string, score: number, passed: boolean) => Promise<string>;
  cleanup: () => Promise<void>;
};

export async function rttWorld(prefix = "rttw"): Promise<RttWorld> {
  const c = await connect();
  const T = tag(prefix);
  const one = async (q: string, p: unknown[]): Promise<string> => (await c.query(q, p)).rows[0].id as string;

  const districtId = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`District ${T}`, T.slice(-12)]);
  const zoneId = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [districtId, `Zone ${T}`]);
  const zone2Id = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [districtId, `Zone2 ${T}`]);
  const district2Id = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [
    `District2 ${T}`,
    `2${T.slice(-11)}`,
  ]);
  const zoneYId = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [district2Id, `ZoneY ${T}`]);
  const schoolIds = new Map<string, string>();
  const schoolIn = async (zone: string): Promise<string> => {
    const known = schoolIds.get(zone);
    if (known) return known;
    const id = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [
      zone,
      `School ${schoolIds.size + 1} ${T}`,
      `${schoolIds.size}${T.slice(-11)}`,
    ]);
    schoolIds.set(zone, id);
    return id;
  };
  const schoolId = await schoolIn(zoneId);

  const userIds: string[] = [];
  const user = async (label: string, role: string): Promise<RttUser> => {
    const name = `${label} ${T}`;
    const email = `${label.toLowerCase()}.${T}@example.test`;
    const id = await one(
      `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, $3::role) RETURNING id`,
      [email, name, role],
    );
    userIds.push(id);
    return { id, role, name, email };
  };
  const teacher = await user("Teacher", "teacher");
  const admin = await user("Admin", "programme_admin");
  const mentor = await user("Mentor", "mentor");
  const observer = await user("Observer", "observer");

  const teacherIds: string[] = [];
  const teacherRow = async (u: RttUser, school: string, fullName: string): Promise<string> => {
    const id = await one(`INSERT INTO teachers (user_id, school_id, full_name) VALUES ($1, $2, $3) RETURNING id`, [
      u.id,
      school,
      fullName,
    ]);
    teacherIds.push(id);
    return id;
  };
  const teacherId = await teacherRow(teacher, schoolId, `Teacher Row ${T}`);
  const mentorId = await one(`INSERT INTO mentors (user_id, name, base_location) VALUES ($1, $2, 'Leh') RETURNING id`, [
    mentor.id,
    `Mentor Row ${T}`,
  ]);
  const pairingId = await one(
    `INSERT INTO mentor_pairings (mentor_id, teacher_id, status, started_at)
     VALUES ($1, $2, 'active', now() - interval '30 days') RETURNING id`,
    [mentorId, teacherId],
  );

  // phases.label is varchar(24) and unique; sequence is unique too.
  const phaseId = await one(`INSERT INTO phases (label, sequence) VALUES ($1, $2) RETURNING id`, [
    `P ${T}`.slice(0, 24),
    2_000_000 + randomInt(1_000_000_000),
  ]);
  const termId = await one(`INSERT INTO terms (phase_id, name, sequence) VALUES ($1, $2, 1) RETURNING id`, [
    phaseId,
    `Term ${T}`,
  ]);

  const subjectIds: string[] = [];
  let n = 0;
  return {
    T,
    c,
    districtId,
    zoneId,
    zone2Id,
    district2Id,
    zoneYId,
    phaseId,
    termId,
    teacher,
    teacherId,
    admin,
    mentor,
    observer,
    user,
    addTeacher: async (label, zone = zoneId) => {
      const u = await user(label, "teacher");
      return { user: u, teacherId: await teacherRow(u, await schoolIn(zone), `${label} Row ${T}`) };
    },
    grant: async (userId, slug) => {
      await c.query(
        `INSERT INTO section_gate_grants (user_id, gate_slug, granted_at, expires_at)
         VALUES ($1, $2::section_gate_slug, now(), now() + interval '8 hours')`,
        [userId, slug],
      );
    },
    subject: async (opts = {}) => {
      const id = await one(
        `INSERT INTO rtt_subjects (term_id, name, active, district_id, zone_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [termId, opts.name ?? `Subject ${++n} ${T}`, opts.active ?? true, opts.districtId ?? null, opts.zoneId ?? null],
      );
      subjectIds.push(id);
      return id;
    },
    module: (subjectId, sequence, title) =>
      one(`INSERT INTO rtt_modules (rtt_subject_id, sequence, title) VALUES ($1, $2, $3) RETURNING id`, [
        subjectId,
        sequence,
        title ?? `Module ${sequence} ${T}`,
      ]),
    lesson: (moduleId, sequence, title) =>
      one(`INSERT INTO rtt_lessons (rtt_module_id, sequence, title) VALUES ($1, $2, $3) RETURNING id`, [
        moduleId,
        sequence,
        title ?? `Lesson ${sequence} ${T}`,
      ]),
    reading: (subjectId, sequence, title) =>
      one(
        `INSERT INTO rtt_readings (rtt_subject_id, sequence, title, external_url) VALUES ($1, $2, $3, $4) RETURNING id`,
        [subjectId, sequence, title ?? `Reading ${sequence} ${T}`, `https://example.test/${T}/${sequence}`],
      ),
    session: (subjectId, opts) =>
      one(
        `INSERT INTO rtt_sessions (rtt_subject_id, sequence, title, type, scheduled_at, link_or_recording)
         VALUES ($1, $2, $3, 'webinar', $4, $5) RETURNING id`,
        [subjectId, opts.sequence, opts.title ?? `Session ${opts.sequence} ${T}`, opts.scheduledAt ?? null, opts.link ?? null],
      ),
    quiz: async (subjectId, opts = {}) => {
      const slug = opts.slug ?? `q${++n}-${T}`.toLowerCase();
      const id = await one(
        `INSERT INTO quizzes (slug, title, rtt_subject_id, pass_threshold, max_attempts, active)
         VALUES ($1, $2, $3, 60, $4, $5) RETURNING id`,
        [slug, opts.title ?? `Quiz ${slug}`, subjectId, opts.maxAttempts ?? null, opts.active ?? true],
      );
      return { id, slug };
    },
    submission: (quizId, userId, score, passed) =>
      one(`INSERT INTO quiz_submissions (quiz_id, user_id, score, passed) VALUES ($1, $2, $3, $4) RETURNING id`, [
        quizId,
        userId,
        score,
        passed,
      ]),
    cleanup: async () => {
      try {
        const subs = subjectIds;
        // quiz_submissions and quiz_attempts cascade from quizzes.
        await c.query(`DELETE FROM quizzes WHERE rtt_subject_id = ANY($1::uuid[])`, [subs]);
        await c.query(
          `DELETE FROM rtt_attendance WHERE rtt_session_id IN (SELECT id FROM rtt_sessions WHERE rtt_subject_id = ANY($1::uuid[]))
              OR teacher_id = ANY($2::uuid[])`,
          [subs, teacherIds],
        );
        await c.query(`DELETE FROM rtt_sessions WHERE rtt_subject_id = ANY($1::uuid[])`, [subs]);
        await c.query(`DELETE FROM rtt_readings WHERE rtt_subject_id = ANY($1::uuid[])`, [subs]);
        await c.query(
          `DELETE FROM rtt_lessons WHERE rtt_module_id IN (SELECT id FROM rtt_modules WHERE rtt_subject_id = ANY($1::uuid[]))`,
          [subs],
        );
        await c.query(`DELETE FROM rtt_modules WHERE rtt_subject_id = ANY($1::uuid[])`, [subs]);
        await c.query(`DELETE FROM rtt_subjects WHERE id = ANY($1::uuid[])`, [subs]);
        await c.query(`DELETE FROM terms WHERE id = $1`, [termId]);
        await c.query(`DELETE FROM phases WHERE id = $1`, [phaseId]);
        await c.query(`DELETE FROM mentor_pairings WHERE id = $1`, [pairingId]);
        await c.query(`DELETE FROM mentors WHERE id = $1`, [mentorId]);
        await c.query(`DELETE FROM teachers WHERE id = ANY($1::uuid[])`, [teacherIds]);
        await c.query(`DELETE FROM schools WHERE id = ANY($1::uuid[])`, [[...schoolIds.values()]]);
        await c.query(`DELETE FROM zones WHERE id = ANY($1::uuid[])`, [[zoneId, zone2Id, zoneYId]]);
        await c.query(`DELETE FROM districts WHERE id = ANY($1::uuid[])`, [[districtId, district2Id]]);
        await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      } finally {
        await c.end();
      }
    },
  };
}
