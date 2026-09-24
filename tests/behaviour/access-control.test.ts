// Access control over the two gated sections, executed against Postgres.
//
// ── THE DEFECTS THESE CATCH ──────────────────────────────────────────────────
//
// /observation and /mentorship are each behind a section password (the gate)
// AND scope their rows to the actor (cycleVisibilityFilter,
// pairingVisibilityFilter). Three surfaces outside those sections re-served the
// same rows with neither control:
//
//   /repo/teacher/[id]   any signed-in teacher opened a colleague from
//                        /repo/teachers and read her observation history --
//                        cycle codes, topics, evaluative vs developmental,
//                        stage -- plus who mentors her and how often they meet.
//   /api/quickfind       Cmd+K, type "OBS" or a colleague's name: other
//                        teachers' cycle codes, topics and UUIDs, and
//                        "Mentor X -> Teacher Y" with the pairing UUID.
//   /repo/session/[id]   the linked-cycle card named any cycle's code and
//                        linked its UUID.
//
// None of it needed the observation or mentorship password.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// Every test builds a small programme inside ONE transaction and rolls it back,
// so nothing persists and concurrent test files cannot collide. The functions
// under test are the ones the page and the route call (lib/gated-reads.ts,
// lib/visibility.ts), handed a drizzle instance bound to that transaction.
// tests/governance/test_security_access_wiring.test.mjs pins that the page and
// the route really do call them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import {
  activeGrant,
  mentorshipAccess,
  observationAccess,
  type Actor,
  type Db,
} from "../../apps/web/src/lib/visibility.js";
import {
  cycleCountsByTeacher,
  linkedCycle,
  mentorRoster,
  searchCycles,
  searchPairings,
  teacherCycleHistory,
  teacherPairingHistory,
} from "../../apps/web/src/lib/gated-reads.js";

const skip = needsDatabase();

type World = {
  T: string;
  admin: Actor;
  teacherA: Actor;
  teacherB: Actor;
  mentor: Actor;
  observer: Actor;
  teacherAId: string;
  teacherBId: string;
  cycleA: { id: string; code: string };
  cycleB: { id: string; code: string };
  pairingA: string;
  pairingB: string;
  mentorMId: string;
  pairingEndedMB: string;
  grant: (userId: string, slug: string, opts?: { expired?: boolean }) => Promise<void>;
};

/**
 * Two teachers, A and B, at one school.
 *   - mentor M is actively paired with A, and had an ENDED pairing with B;
 *   - a second mentor (no login) is actively paired with B;
 *   - observer O is assigned to A's cycle; B's cycle has no observer.
 * Nobody holds a section grant until a test calls grant().
 */
async function withWorld(body: (db: Db, w: World) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  await c.query("BEGIN");
  try {
    const T = tag("acl");
    const one = async (q: string, params: unknown[]): Promise<string> =>
      (await c.query(q, params)).rows[0].id as string;

    const district = await one(
      `INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`,
      [`District ${T}`, T.slice(-12)],
    );
    const zone = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [
      district,
      `Zone ${T}`,
    ]);
    const school = await one(
      `INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`,
      [zone, `School ${T}`, T.slice(-12)],
    );

    const user = async (label: string, role: string): Promise<Actor> => {
      const id = await one(
        `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, $3::role) RETURNING id`,
        [`${label}.${T}@example.test`, `${label} ${T}`, role],
      );
      return { id, role };
    };
    const admin = await user("admin", "programme_admin");
    const teacherA = await user("teacher-a", "teacher");
    const teacherB = await user("teacher-b", "teacher");
    const mentor = await user("mentor", "mentor");
    const observer = await user("observer", "observer");

    const teacher = (u: Actor, name: string) =>
      one(`INSERT INTO teachers (user_id, school_id, full_name) VALUES ($1, $2, $3) RETURNING id`, [
        u.id,
        school,
        name,
      ]);
    const teacherAId = await teacher(teacherA, `Teacher A ${T}`);
    const teacherBId = await teacher(teacherB, `Teacher B ${T}`);

    const mentorM = await one(
      `INSERT INTO mentors (user_id, name, base_location) VALUES ($1, $2, 'Leh') RETURNING id`,
      [mentor.id, `Mentor M ${T}`],
    );
    const mentorOther = await one(
      `INSERT INTO mentors (name, base_location) VALUES ($1, 'Kargil') RETURNING id`,
      [`Mentor Other ${T}`],
    );
    const pairing = (m: string, t: string, status: string, startedDaysAgo: number) =>
      one(
        `INSERT INTO mentor_pairings (mentor_id, teacher_id, status, started_at, meetings_count, current_quarter)
         VALUES ($1, $2, $3::pairing_status, now() - make_interval(days => $4), 3, 2) RETURNING id`,
        [m, t, status, startedDaysAgo],
      );
    const pairingA = await pairing(mentorM, teacherAId, "active", 30);
    const pairingB = await pairing(mentorOther, teacherBId, "active", 30);
    const pairingEndedMB = await pairing(mentorM, teacherBId, "ended", 400);

    const cycle = async (t: string, code: string, observerId: string | null) => ({
      code,
      id: await one(
        `INSERT INTO observation_cycles (code, teacher_id, observer_id, kind, topic, scheduled_at)
         VALUES ($1, $2, $3, 'evaluative', 'Fractions', now()) RETURNING id`,
        [code, t, observerId],
      ),
    });
    const cycleA = await cycle(teacherAId, `${T}-A1`, observer.id);
    const cycleB = await cycle(teacherBId, `${T}-B1`, null);

    const grant: World["grant"] = async (userId, slug, opts) => {
      // The table CHECKs expires_at <= granted_at + 8h, so an expired grant is
      // one issued nine hours ago that lapsed an hour ago.
      await c.query(
        opts?.expired
          ? `INSERT INTO section_gate_grants (user_id, gate_slug, granted_at, expires_at)
             VALUES ($1, $2::section_gate_slug, now() - interval '9 hours', now() - interval '1 hour')`
          : `INSERT INTO section_gate_grants (user_id, gate_slug, granted_at, expires_at)
             VALUES ($1, $2::section_gate_slug, now(), now() + interval '8 hours')`,
        [userId, slug],
      );
    };

    const db = drizzle(c) as unknown as Db;
    await body(db, {
      T,
      admin,
      teacherA,
      teacherB,
      mentor,
      observer,
      teacherAId,
      teacherBId,
      cycleA,
      cycleB,
      pairingA,
      pairingB,
      mentorMId: mentorM,
      pairingEndedMB,
      grant,
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

/** What /repo/teacher/[id] renders for `viewer` looking at teacher `teacherId`. */
async function repoTeacherPage(db: Db, viewer: Actor, teacherId: string) {
  const [obs, mship] = await Promise.all([observationAccess(db, viewer), mentorshipAccess(db, viewer)]);
  const cycles = await teacherCycleHistory(db, obs, teacherId);
  const pairings = await teacherPairingHistory(db, mship, teacherId);
  return {
    cycles: cycles === null ? null : cycles.map((r) => r.code),
    pairings: pairings === null ? null : pairings.map((r) => r.id),
  };
}

/** What /api/quickfind returns for the two gated kinds. */
async function quickfind(db: Db, viewer: Actor, q: string) {
  const [obs, mship] = await Promise.all([observationAccess(db, viewer), mentorshipAccess(db, viewer)]);
  const pattern = `%${q}%`;
  const cycles = await searchCycles(db, obs, pattern, 20);
  const pairings = await searchPairings(db, mship, pattern, 20);
  return { cycles: cycles.map((r) => r.code).sort(), pairings: pairings.map((r) => r.id).sort() };
}

// ── /repo/teacher/[id] ───────────────────────────────────────────────────────

test("/repo/teacher: a teacher opening a COLLEAGUE sees neither her cycles nor her mentor", { skip }, async () => {
  await withWorld(async (db, w) => {
    await w.grant(w.teacherA.id, "observation");
    await w.grant(w.teacherA.id, "mentorship");

    const colleague = await repoTeacherPage(db, w.teacherA, w.teacherBId);
    assert.deepEqual(colleague.cycles, [], "teacher A must not read teacher B's observation history");
    assert.deepEqual(colleague.pairings, [], "teacher A must not read who mentors teacher B");

    const own = await repoTeacherPage(db, w.teacherA, w.teacherAId);
    assert.deepEqual(own.cycles, [w.cycleA.code], "her own history is still hers to see");
    assert.deepEqual(own.pairings, [w.pairingA]);
  });
});

test("/repo/teacher: without the section password, neither card is served — to anyone", { skip }, async () => {
  await withWorld(async (db, w) => {
    // null is the page's "locked" state: no query ran, so not even the
    // "Recent observation cycles (N)" count reaches the page.
    for (const viewer of [w.teacherA, w.mentor, w.observer, w.admin]) {
      const page = await repoTeacherPage(db, viewer, w.teacherAId);
      assert.equal(page.cycles, null, `${viewer.role} without the observation grant got cycle rows`);
      assert.equal(page.pairings, null, `${viewer.role} without the mentorship grant got pairing rows`);
    }
  });
});

test("/repo/teacher: a mentor sees their ACTIVE mentee's history, not a past mentee's", { skip }, async () => {
  await withWorld(async (db, w) => {
    await w.grant(w.mentor.id, "observation");
    await w.grant(w.mentor.id, "mentorship");

    const mentee = await repoTeacherPage(db, w.mentor, w.teacherAId);
    assert.deepEqual(mentee.cycles, [w.cycleA.code]);
    assert.deepEqual(mentee.pairings, [w.pairingA]);

    // M's pairing with B ENDED. M may still see that pairing (it is M's own),
    // but B's observation cycles are no longer M's business, and B's CURRENT
    // mentor's pairing never was.
    const past = await repoTeacherPage(db, w.mentor, w.teacherBId);
    assert.deepEqual(past.cycles, [], "an ended pairing must not keep granting sight of the teacher's cycles");
    assert.ok(!past.pairings?.includes(w.pairingB), "another mentor's pairing leaked to M");
  });
});

test("/repo/teacher: an observer sees only cycles they observe, and no pairing card", { skip }, async () => {
  await withWorld(async (db, w) => {
    await w.grant(w.observer.id, "observation");
    await w.grant(w.observer.id, "mentorship");

    const observed = await repoTeacherPage(db, w.observer, w.teacherAId);
    assert.deepEqual(observed.cycles, [w.cycleA.code]);
    assert.deepEqual(observed.pairings, [], "observers have no role in mentorship");

    const other = await repoTeacherPage(db, w.observer, w.teacherBId);
    assert.deepEqual(other.cycles, []);
  });
});

test("/repo/teacher: an admin holding the grants sees everything", { skip }, async () => {
  await withWorld(async (db, w) => {
    await w.grant(w.admin.id, "observation");
    await w.grant(w.admin.id, "mentorship");
    const page = await repoTeacherPage(db, w.admin, w.teacherBId);
    assert.deepEqual(page.cycles, [w.cycleB.code]);
    assert.ok(page.pairings?.includes(w.pairingB));
  });
});

// ── /repo/mentor/[id] ────────────────────────────────────────────────────────

test("/repo/mentor: the mentee roster needs the mentorship password, then only visible rows", { skip }, async () => {
  await withWorld(async (db, w) => {
    const roster = async (viewer: Actor) => {
      const rows = await mentorRoster(db, await mentorshipAccess(db, viewer), w.mentorMId);
      return rows === null ? null : rows.map((r) => r.id).sort();
    };

    assert.equal(await roster(w.teacherA), null, "M's mentee roster was served without the mentorship password");

    await w.grant(w.teacherA.id, "mentorship");
    assert.deepEqual(await roster(w.teacherA), [w.pairingA], "a mentee sees her own pairing, not M's other mentees");

    await w.grant(w.mentor.id, "mentorship");
    assert.deepEqual(await roster(w.mentor), [w.pairingA, w.pairingEndedMB].sort());

    await w.grant(w.observer.id, "mentorship");
    assert.deepEqual(await roster(w.observer), [], "observers have no role in mentorship");
  });
});

// ── /api/quickfind ───────────────────────────────────────────────────────────

test("/api/quickfind: a teacher's Cmd+K returns only her own cycles and pairings", { skip }, async () => {
  await withWorld(async (db, w) => {
    await w.grant(w.teacherA.id, "observation");
    await w.grant(w.teacherA.id, "mentorship");

    // The tag appears in both cycle codes and in every teacher and mentor name,
    // so an unscoped search matches all of them.
    const hits = await quickfind(db, w.teacherA, w.T);
    assert.deepEqual(hits.cycles, [w.cycleA.code], "another teacher's cycle code came back from quickfind");
    assert.deepEqual(hits.pairings, [w.pairingA], "another teacher's 'Mentor -> Teacher' pairing came back");
  });
});

test("/api/quickfind: without the section passwords, no cycle or pairing comes back", { skip }, async () => {
  await withWorld(async (db, w) => {
    for (const viewer of [w.teacherA, w.admin]) {
      const hits = await quickfind(db, viewer, w.T);
      assert.deepEqual(hits, { cycles: [], pairings: [] }, `${viewer.role} searched gated rows without a grant`);
    }
  });
});

test("/api/quickfind: an admin holding the grants still finds everything", { skip }, async () => {
  await withWorld(async (db, w) => {
    await w.grant(w.admin.id, "observation");
    await w.grant(w.admin.id, "mentorship");
    const hits = await quickfind(db, w.admin, w.T);
    assert.deepEqual(hits.cycles, [w.cycleA.code, w.cycleB.code].sort());
    assert.ok(hits.pairings.includes(w.pairingA) && hits.pairings.includes(w.pairingB));
  });
});

// ── /repo/teachers "Obs. cycles" column ──────────────────────────────────────

/** The per-teacher counts /repo/teachers joins in, for the two fixture teachers. */
async function cycleCounts(db: Db, viewer: Actor, w: World) {
  const sub = cycleCountsByTeacher(db, await observationAccess(db, viewer));
  const rows = await db.select({ teacherId: sub.teacherId, n: sub.cyclesTotal }).from(sub);
  const of = (id: string) => rows.find((r) => r.teacherId === id)?.n ?? 0;
  return { A: of(w.teacherAId), B: of(w.teacherBId) };
}

test("/repo/teachers: the cycle count column counts only cycles the viewer may see", { skip }, async () => {
  await withWorld(async (db, w) => {
    assert.deepEqual(await cycleCounts(db, w.teacherA, w), { A: 0, B: 0 }, "locked: nothing is counted");

    await w.grant(w.teacherA.id, "observation");
    assert.deepEqual(
      await cycleCounts(db, w.teacherA, w),
      { A: 1, B: 0 },
      "a colleague's observation count is observation data too",
    );

    await w.grant(w.admin.id, "observation");
    assert.deepEqual(await cycleCounts(db, w.admin, w), { A: 1, B: 1 });
  });
});

// ── /repo/session/[id] linked-cycle card ─────────────────────────────────────

test("/repo/session: the linked-cycle card names only a cycle the viewer may open", { skip }, async () => {
  await withWorld(async (db, w) => {
    assert.equal(await linkedCycle(db, await observationAccess(db, w.teacherA), w.cycleA.id), null, "locked");

    await w.grant(w.teacherA.id, "observation");
    const access = await observationAccess(db, w.teacherA);
    assert.equal((await linkedCycle(db, access, w.cycleA.id))?.code, w.cycleA.code);
    assert.equal(await linkedCycle(db, access, w.cycleB.id), null, "a colleague's cycle code leaked");
  });
});

// ── the grant itself ─────────────────────────────────────────────────────────

test("/api/admin/audit/export: an admin ROLE is not an admin section grant", { skip }, async () => {
  // The export route answers 403 gate_required exactly when getActiveGrant --
  // this function bound to the app's db -- returns null for (user, "admin").
  // It used to check the role only, so any admin session pulled the whole log.
  await withWorld(async (db, w) => {
    assert.equal(await activeGrant(db, w.admin.id, "admin"), null, "the role alone must not unlock the audit log");
    await w.grant(w.admin.id, "observation");
    await w.grant(w.admin.id, "mentorship");
    assert.equal(await activeGrant(db, w.admin.id, "admin"), null, "another section's password is not the admin one");
    await w.grant(w.admin.id, "admin");
    assert.notEqual(await activeGrant(db, w.admin.id, "admin"), null);
  });
});

test("a grant unlocks only its own section, only for its own user, and only until it expires", { skip }, async () => {
  await withWorld(async (db, w) => {
    await w.grant(w.teacherA.id, "mentorship");
    await w.grant(w.teacherB.id, "observation");
    await w.grant(w.teacherA.id, "admin", { expired: true });

    assert.equal(await activeGrant(db, w.teacherA.id, "observation"), null, "a mentorship grant opened observation");
    assert.notEqual(await activeGrant(db, w.teacherA.id, "mentorship"), null);
    assert.notEqual(await activeGrant(db, w.teacherB.id, "observation"), null);
    assert.equal(await activeGrant(db, w.teacherA.id, "admin"), null, "an expired grant was honoured");
    assert.equal((await observationAccess(db, w.teacherA)).granted, false, "B's grant unlocked A");
  });
});
