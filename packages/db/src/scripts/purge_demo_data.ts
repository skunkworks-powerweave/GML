// Remove the seed's FICTIONAL programme data, keeping the real reference data.
//
// ── WHAT THE SEED PUTS IN, AND WHICH HALF IS MADE UP ─────────────────────────
//
// seed.ts inserts two quite different kinds of row and does not distinguish
// them:
//
//   REAL      2 districts (Leh, Kargil) and 11 zones (Nubra, Drass, Zangskar,
//             Khaltsi, Sankoo, Shargole ...). These are actual Ladakh
//             administrative divisions and a real programme wants them.
//             Phases, terms, subjects, the form catalogue and the section
//             gates are likewise genuine structure. (Quizzes are not among
//             them: nothing seeds quizzes, and this script does not touch the
//             quiz tables, so admin-authored quizzes survive a purge.)
//
//   INVENTED  10 schools with sequential contact numbers (+91 1985 200001..),
//             10 teachers with sequential mobiles (+91 9419100001..), 2
//             mentors, 10 pairings and 8 observation cycles OBS-2026-001..008.
//             This is demonstration data. Leaving it in a live programme means
//             fictional teachers appear in the roster, in QuickFind, in every
//             admin grid and in the dashboard counts, indistinguishable from
//             real staff.
//
// ── WHY THIS IS A SCRIPT AND NOT "JUST DELETE THE ROWS" ──────────────────────
//
// Three things make hand-deletion go wrong:
//
//   1. ORDER. teachers <- observation_cycles, teachers <- mentor_pairings and
//      teachers <- sessions are all ON DELETE RESTRICT, so a teacher cannot be
//      removed until those are gone. schools <- teachers is RESTRICT too.
//      Deleting in the obvious order fails partway and leaves a half-purged
//      database.
//
//   2. THE SEED COMES BACK IF YOU DELETE TOO MUCH. seed.ts's idempotency guard
//      is a single check: "if any districts exist, skip everything". deploy.sh
//      runs the seed on EVERY deploy, so a purge that also removed the
//      districts would silently reinstate all ten fictional teachers on the
//      next deployment. Keeping the districts is what makes this permanent --
//      and it is why this script refuses to touch them.
//
//      The one seeded thing that does NOT survive is the three observation
//      templates seed_forms_observation.ts hangs on OBS-2026-001: they have no
//      submitter, so they are not "real work", and they cascade away with that
//      demo cycle. Nothing in the application reads them. On every later
//      deploy that seed step warns that the cycle is gone and skips -- it must
//      not fail, or deploy.sh stops at the seed step forever after a purge.
//
//   3. REAL WORK MAY ALREADY BE ATTACHED. If anyone has used a demo cycle for
//      a genuine observation, or a demo pairing for genuine mentoring --
//      easily done, they look real -- deleting it takes that work with it.
//      Every candidate is checked for attached submissions, evidence, videos,
//      meetings, feedback responses, commitments and drafts first, and
//      anything with real work is REPORTED AND KEPT, together with the teacher
//      and mentor it cannot exist without. The seed writes none of those
//      things, so any of them is someone's work.
//
//   4. REAL ROWS CAN LOOK LIKE SEED ROWS. /observation/new mints cycle codes
//      as OBS-<year>-<max+1>, so a real 2026 cycle is OBS-2026-009 onward --
//      or OBS-2026-001 again once the seed's have been purged. A mentor record
//      called "Dr. Anjali Bhatt" may have a real login linked to it, and so
//      may a teacher record with a seed mobile. So rows are matched on the
//      seed's exact literals, a cycle only counts as demo when its teacher is
//      a demo teacher with no login and no uploads, and a mentor with a login
//      is never removed.
//
// What goes WITH the listed rows -- the removed teachers' classroom sessions
// and RTT attendance marks, the demo schools' classes and learners -- is not
// seed data either. The dry run counts it, table by table, before anyone
// types --apply.
//
// ── USE ──────────────────────────────────────────────────────────────────────
//
//   docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/purge_demo_data.ts
//       Dry run. Lists every row that would go and every candidate that would
//       be kept, and why. Changes nothing. This is the default deliberately.
//
//   ... purge_demo_data.ts --apply
//       Does it, in one transaction.
//
// Safe to run twice: the second run removes nothing and says so.

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, getPool } from "../client.js";

const APPLY = process.argv.includes("--apply");

/**
 * How the fictional rows are recognised.
 *
 * Matched on the seed's own literals rather than on "looks fake", so a real
 * school that happens to be called GHS Leh is never caught by accident. If the
 * seed data changes, these change with it.
 * tests/governance/test_data_purge_recognises_seed pins every list to seed.ts.
 */
const DEMO_SCHOOL_CODES = [
  "GPS-CHU", "GMS-KHA", "GHS-DSK", "GMS-DRS", "GHS-PDM",
  "GHS-KGL", "GMS-NYM", "GHS-LEH", "GPS-SNK", "GMS-SRG",
];
/**
 * The seed's ten teachers, by the mobile each was given.
 *
 * Exact numbers, not the prefix `+91 94191000` this used to match: +91 94191
 * is a live mobile block in Ladakh, so a prefix can catch a real teacher.
 */
const DEMO_TEACHER_PHONES = [
  "+91 9419100001", "+91 9419100002", "+91 9419100003", "+91 9419100004", "+91 9419100005",
  "+91 9419100006", "+91 9419100007", "+91 9419100008", "+91 9419100009", "+91 9419100010",
];
/**
 * The seed's eight cycles.
 *
 * This was the prefix `OBS-2026-0`, and /observation/new mints real codes as
 * OBS-<year>-<max+1> -- so every real cycle created in 2026 up to OBS-2026-099
 * matched it, and any of them without submitted work was deleted. Even the
 * exact codes are not enough on their own: once the seed's cycles are gone,
 * the next real one minted is OBS-2026-001 again. A cycle is demo data only
 * when it carries one of these codes AND its teacher is a demo teacher.
 */
const DEMO_CYCLE_CODES = [
  "OBS-2026-001", "OBS-2026-002", "OBS-2026-003", "OBS-2026-004",
  "OBS-2026-005", "OBS-2026-006", "OBS-2026-007", "OBS-2026-008",
];
/**
 * The seed's two mentors.
 *
 * This list read 'Dr. Anjali Bhatt', 'Rinchen Angmo' -- but Rinchen Angmo is
 * one of the seed's TEACHERS, so the seed's second mentor, Prof. Iqbal
 * Hussain, survived every purge and stayed in the live mentor roster.
 *
 * A name is not an identity: a mentor record with a login linked to it is a
 * real person's record, whatever it is called, and is never removed.
 */
const DEMO_MENTOR_NAMES = ["Dr. Anjali Bhatt", "Prof. Iqbal Hussain"];

type Row = Record<string, unknown>;
/** db, or the transaction --apply runs in. */
type Exec = Pick<typeof db, "execute">;
const rowsOf = async (q: Exec, query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await q.execute(query)) as unknown as { rows: Row[] }).rows ?? [];

const n = (v: unknown): number => Number(v ?? 0);

/**
 * A parenthesised, parameterised value list for use with IN / NOT IN.
 *
 * Drizzle's sql`` does not bind a JS array as a Postgres array, so
 * `= ANY(${arr}::text[])` fails with 42846 "cannot cast type". Joining the
 * values into a real list keeps every one of them a bound parameter -- no
 * interpolation into the statement text.
 */
const valueList = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** An id list for IN / NOT IN; a sentinel stands in for none, as `IN ()` is a syntax error. */
const ids = (rows: Row[]) =>
  valueList(rows.length ? rows.map((r) => String(r.id)) : ["00000000-0000-0000-0000-000000000000"]);

/**
 * Exactly what a purge removes, and what it keeps and why.
 *
 * The dry run prints this and --apply deletes it, row by row, by id -- so what
 * the operator reviewed is what goes. It used to be counts in the dry run and
 * pattern-matched DELETEs in --apply, and nothing tied the two together.
 */
type Plan = {
  cycles: Row[];
  keptCycles: Row[];
  pairings: Row[];
  keptPairings: Row[];
  teachers: Row[];
  keptTeachers: Row[];
  mentors: Row[];
  keptMentors: Row[];
  schools: Row[];
  /** Counts of the rows that go with the listed ones, or are unlinked by them. */
  also: Row;
};

async function plan(q: Exec): Promise<Plan> {
  // A teacher who has uploaded anything, or who has been given a login, is
  // real, and so is everything hanging off them: their pairings and cycles are
  // not candidates at all.
  const teachers = await rowsOf(q, sql`
    SELECT t.id, t.full_name, t.phone, t.user_id,
           (SELECT count(*) FROM video_submissions v
              JOIN users u ON u.id = v.submitted_by_user_id
              WHERE u.id = t.user_id)::int AS uploads
    FROM teachers t
    WHERE t.phone IN (${valueList(DEMO_TEACHER_PHONES)})
    ORDER BY t.full_name`);
  const ownWork = (r: Row) => r.user_id !== null || n(r.uploads) > 0;
  const candidates = teachers.filter((r) => !ownWork(r));

  // So a cycle is a candidate only when its teacher is. /observation/new
  // re-mints the seed's codes once they are free, and a demo teacher record a
  // real teacher has since been given a login to keeps its seed mobile: that
  // teacher's new OBS-2026-001 is theirs, not the seed's.
  //
  // A draft is work too, and it would go silently: form_drafts CASCADE with
  // their cycle or pairing. Every draft belongs to a login (user_id is NOT
  // NULL) and the seed writes none.
  //
  // A cycle someone has actually used is not demo data any more, whatever its
  // code says. Checked BEFORE anything is deleted, and such a cycle is kept.
  const cycles = await rowsOf(q, sql`
    SELECT c.id, c.code, t.full_name AS teacher,
           (SELECT count(*) FROM observation_forms f WHERE f.cycle_id = c.id
              AND f.submitted_by_user_id IS NOT NULL)::int AS forms,
           (SELECT count(*) FROM video_submissions v WHERE v.context_id = c.id
              AND v.context_type = 'observation_cycle')::int AS videos,
           (SELECT count(*) FROM observation_evidence e WHERE e.cycle_id = c.id)::int AS evidence,
           (SELECT count(*) FROM form_drafts d WHERE d.observation_cycle_id = c.id)::int AS drafts
    FROM observation_cycles c JOIN teachers t ON t.id = c.teacher_id
    WHERE c.code IN (${valueList(DEMO_CYCLE_CODES)}) AND c.teacher_id IN (${ids(candidates)})
    ORDER BY c.code`);
  const cycleWork = (r: Row) => n(r.forms) + n(r.videos) + n(r.evidence) + n(r.drafts) > 0;

  // The seed writes pairings and nothing on them: no meetings, no feedback
  // responses, no quarterly videos, no commitments, no drafts. Any of those is
  // a real mentor's or mentee's work, and keeps the pairing.
  const pairings = await rowsOf(q, sql`
    SELECT p.id, t.full_name AS teacher, m.name AS mentor,
           (SELECT count(*) FROM mentor_meetings mm WHERE mm.pairing_id = p.id)::int AS meetings,
           (SELECT count(*) FROM feedback_responses fr WHERE fr.pairing_id = p.id)::int AS responses,
           (SELECT count(*) FROM video_submissions v WHERE v.context_id = p.id
              AND v.context_type = 'mentee_quarterly')::int AS videos,
           jsonb_array_length(p.commitments) AS commitments,
           (SELECT count(*) FROM form_drafts d WHERE d.pairing_id = p.id)::int AS drafts
    FROM mentor_pairings p
    JOIN teachers t ON t.id = p.teacher_id
    JOIN mentors m ON m.id = p.mentor_id
    WHERE p.teacher_id IN (${ids(candidates)})
    ORDER BY t.full_name, m.name`);
  const pairingWork = (r: Row) =>
    n(r.meetings) + n(r.responses) + n(r.videos) + n(r.commitments) + n(r.drafts) > 0;

  const doomedCycles = cycles.filter((r) => !cycleWork(r));
  const doomedPairings = pairings.filter((r) => !pairingWork(r));

  // A teacher goes only if nothing that stays still points at them: a kept
  // cycle or a kept pairing cannot outlive its teacher (both are ON DELETE
  // RESTRICT, and the whole purge would roll back with 23503).
  const heldTeachers = await rowsOf(q, sql`
    SELECT teacher_id AS id FROM observation_cycles WHERE id NOT IN (${ids(doomedCycles)})
    UNION
    SELECT teacher_id FROM mentor_pairings WHERE id NOT IN (${ids(doomedPairings)})`);
  const held = new Set(heldTeachers.map((r) => String(r.id)));
  const doomedTeachers = candidates.filter((r) => !held.has(String(r.id)));

  // Mentors, once no pairing that stays references them -- and never one with
  // a login linked to it.
  const mentors = await rowsOf(q, sql`
    SELECT m.id, m.name, m.user_id,
           (SELECT count(*) FROM mentor_pairings p WHERE p.mentor_id = m.id
              AND p.id NOT IN (${ids(doomedPairings)}))::int AS pairings
    FROM mentors m
    WHERE m.name IN (${valueList(DEMO_MENTOR_NAMES)})
    ORDER BY m.name, m.id`);
  const mentorHeld = (r: Row) => r.user_id !== null || n(r.pairings) > 0;

  // Schools last, once no teacher that stays belongs to them.
  const schools = await rowsOf(q, sql`
    SELECT s.id, s.code, s.name FROM schools s
    WHERE s.code IN (${valueList(DEMO_SCHOOL_CODES)})
      AND s.id NOT IN (SELECT school_id FROM teachers WHERE id NOT IN (${ids(doomedTeachers)}))
    ORDER BY s.code`);

  // What goes with them, which remove() deletes by teacher and by school, and
  // what they leave pointing at nothing (ON DELETE SET NULL). The seed writes
  // none of the sessions, marks, learners or classes, so the operator sees
  // how many there are before deciding.
  const cyc = ids(doomedCycles);
  const tch = ids(doomedTeachers);
  const sch = ids(schools);
  const [also = {}] = await rowsOf(q, sql`
    SELECT
      (SELECT count(*) FROM observation_forms WHERE cycle_id IN (${cyc})
         AND submitted_by_user_id IS NULL)::int AS templates,
      (SELECT count(*) FROM sessions WHERE teacher_id IN (${tch}) OR school_id IN (${sch}))::int AS sessions,
      (SELECT count(*) FROM rtt_attendance WHERE teacher_id IN (${tch}))::int AS attendance,
      (SELECT count(*) FROM learners WHERE school_id IN (${sch}))::int AS learners,
      (SELECT count(*) FROM classes WHERE school_id IN (${sch}))::int AS classes,
      (SELECT count(*) FROM sessions WHERE observation_cycle_id IN (${cyc})
         AND teacher_id NOT IN (${tch}) AND school_id NOT IN (${sch}))::int AS unlinked_sessions,
      (SELECT count(*) FROM course_outlines WHERE owner_teacher_id IN (${tch}))::int AS unowned_outlines`);

  const doomedTeacherIds = new Set(doomedTeachers.map((r) => String(r.id)));
  return {
    also,
    cycles: doomedCycles,
    keptCycles: cycles.filter(cycleWork),
    pairings: doomedPairings,
    keptPairings: pairings.filter(pairingWork),
    teachers: doomedTeachers,
    keptTeachers: teachers.filter((r) => !doomedTeacherIds.has(String(r.id))),
    mentors: mentors.filter((r) => !mentorHeld(r)),
    keptMentors: mentors.filter(mentorHeld),
    schools,
  };
}

function report(p: Plan): void {
  const removals = p.cycles.length + p.pairings.length + p.teachers.length + p.mentors.length + p.schools.length;
  console.log(`  WILL BE REMOVED (${removals} rows):`);
  for (const r of p.cycles) console.log(`    cycle    ${r.code}  teacher ${r.teacher}`);
  for (const r of p.pairings) console.log(`    pairing  ${r.id}  ${r.teacher} <-> ${r.mentor}`);
  for (const r of p.teachers) console.log(`    teacher  ${r.full_name}  ${r.phone}`);
  for (const r of p.mentors) console.log(`    mentor   ${r.id}  ${r.name}`);
  for (const r of p.schools) console.log(`    school   ${r.code}  ${r.name}`);
  if (removals === 0) {
    console.log("    nothing");
  } else {
    const a = p.also;
    console.log("\n  and, with them:");
    console.log(`    observation form templates  ${n(a.templates)}  unsubmitted, on the cycles above`);
    console.log(`    classroom sessions          ${n(a.sessions)}  of the teachers above, or at the schools above`);
    console.log(`    RTT attendance marks        ${n(a.attendance)}  of the teachers above`);
    console.log(`    learners                    ${n(a.learners)}  children's records at the schools above`);
    console.log(`    classes                     ${n(a.classes)}  at the schools above`);
    console.log("  and, kept but no longer linked to them:");
    console.log(`    sessions of other teachers  ${n(a.unlinked_sessions)}  lose their link to a cycle above`);
    console.log(`    course outlines             ${n(a.unowned_outlines)}  lose their owner, a teacher above`);
  }

  // Everything below this heading is kept. (The purge tests read the listing
  // on either side of it.)
  console.log("\n  KEPT -- review these by hand:");
  for (const r of p.keptCycles) {
    console.log(
      `    cycle    ${r.code}  real work: forms=${n(r.forms)} videos=${n(r.videos)} ` +
        `evidence=${n(r.evidence)} drafts=${n(r.drafts)}`,
    );
  }
  for (const r of p.keptPairings) {
    console.log(
      `    pairing  ${r.id}  ${r.teacher} <-> ${r.mentor}  real work: meetings=${n(r.meetings)} ` +
        `responses=${n(r.responses)} videos=${n(r.videos)} commitments=${n(r.commitments)} drafts=${n(r.drafts)}`,
    );
  }
  for (const r of p.keptTeachers) {
    const why = r.user_id !== null || n(r.uploads) > 0
      ? `login=${r.user_id ? "set" : "none"} uploads=${n(r.uploads)}, so their cycles and pairings stay too`
      : "a cycle or pairing that stays is theirs";
    console.log(`    teacher  ${r.full_name}  ${r.phone}  ${why}`);
  }
  for (const r of p.keptMentors) {
    console.log(`    mentor   ${r.id}  ${r.name}  ${r.user_id ? "a login is linked to it" : `pairings kept=${n(r.pairings)}`}`);
  }
  const kept = p.keptCycles.length + p.keptPairings.length + p.keptTeachers.length + p.keptMentors.length;
  if (kept === 0) console.log("    nothing");
}

async function remove(q: Exec, p: Plan): Promise<void> {
  const cycles = ids(p.cycles);
  const pairings = ids(p.pairings);

  // Drafts CASCADE with their cycle or pairing, so one saved after the plan
  // was made would go with it, unlisted. Lock the rows first: a draft saved
  // from here on waits for this transaction and then fails its foreign key,
  // and one saved in between is visible to the count below (each statement
  // takes a fresh snapshot) and stops the purge.
  await q.execute(sql`SELECT 1 FROM observation_cycles WHERE id IN (${cycles}) FOR UPDATE`);
  await q.execute(sql`SELECT 1 FROM mentor_pairings WHERE id IN (${pairings}) FOR UPDATE`);
  const [late = {}] = await rowsOf(q, sql`
    SELECT count(*)::int AS drafts FROM form_drafts
    WHERE observation_cycle_id IN (${cycles}) OR pairing_id IN (${pairings})`);
  if (n(late.drafts) > 0) {
    throw new Error(
      `${n(late.drafts)} draft(s) were saved on the cycles or pairings listed above while the purge ` +
        "was running. Nothing was removed; run it again and they will be kept.",
    );
  }

  // Cycles first: they RESTRICT teacher deletion. Their forms and evidence
  // are RESTRICT since migration 0031 (so a grid delete cannot erase
  // submitted work): a cycle in the plan has no submitted form, no evidence
  // and no draft, so only the seed's unsubmitted templates are removed here.
  // Anything submitted since the plan was made blocks the DELETE and rolls
  // the purge back rather than going with it.
  await q.execute(sql`DELETE FROM observation_forms WHERE cycle_id IN (${cycles}) AND submitted_by_user_id IS NULL`);
  await q.execute(sql`DELETE FROM observation_cycles WHERE id IN (${cycles})`);

  // Pairings RESTRICT both mentors and teachers. A pairing in the plan has no
  // meetings, no feedback responses and no drafts. Meetings and responses are
  // RESTRICT since 0031 and deliberately NOT deleted here, so one recorded
  // after the plan was made makes this fail instead of taking it.
  await q.execute(sql`DELETE FROM mentor_pairings WHERE id IN (${pairings})`);

  // sessions.teacher_id and rtt_attendance.teacher_id are RESTRICT, so these
  // must go before the teachers.
  const teachers = ids(p.teachers);
  await q.execute(sql`DELETE FROM sessions WHERE teacher_id IN (${teachers})`);
  await q.execute(sql`DELETE FROM rtt_attendance WHERE teacher_id IN (${teachers})`);
  await q.execute(sql`DELETE FROM teachers WHERE id IN (${teachers})`);

  await q.execute(sql`DELETE FROM mentors WHERE id IN (${ids(p.mentors)}) AND user_id IS NULL`);

  // Schools last: teachers RESTRICT them. Their learners, remaining sessions
  // and classes used to cascade and are RESTRICT since 0031, so they are
  // removed first, children before classes.
  const schools = ids(p.schools);
  await q.execute(sql`DELETE FROM learners WHERE school_id IN (${schools})`);
  await q.execute(sql`DELETE FROM sessions WHERE school_id IN (${schools})`);
  await q.execute(sql`DELETE FROM classes WHERE school_id IN (${schools})`);
  await q.execute(sql`DELETE FROM schools WHERE id IN (${schools})`);
}

async function main(): Promise<void> {
  console.log(APPLY ? "\n[purge] APPLYING\n" : "\n[purge] DRY RUN — nothing will be changed. Re-run with --apply to commit.\n");

  if (!APPLY) {
    const p = await plan(db);
    const found = Object.values(p).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0);
    if (found === 0) {
      console.log("  Nothing to purge — no demo rows found. (Already done, or this is real data.)\n");
    } else {
      report(p);
      console.log("\n  Dry run complete. Nothing was changed.");
      console.log("  Re-run with --apply to remove the rows listed above.\n");
    }
    await getPool().end();
    return;
  }

  // One transaction: a purge that half-succeeds is worse than one that fails.
  // The plan is made inside it, so what is printed is what is deleted.
  await db.transaction(async (tx) => {
    const p = await plan(tx);
    report(p);
    await remove(tx, p);
  });

  // ── What is left ───────────────────────────────────────────────────────────
  const after = await rowsOf(db, sql`
    SELECT
      (SELECT count(*) FROM schools)::int             AS schools,
      (SELECT count(*) FROM teachers)::int            AS teachers,
      (SELECT count(*) FROM mentors)::int             AS mentors,
      (SELECT count(*) FROM observation_cycles)::int  AS cycles,
      (SELECT count(*) FROM districts)::int           AS districts,
      (SELECT count(*) FROM zones)::int               AS zones`);
  const a = after[0] ?? {};
  console.log("\n  Remaining:");
  console.log(`    schools ${n(a.schools)}  teachers ${n(a.teachers)}  mentors ${n(a.mentors)}  cycles ${n(a.cycles)}`);
  console.log(`    districts ${n(a.districts)}  zones ${n(a.zones)}   <- kept deliberately`);
  console.log("\n  The districts are KEPT on purpose. seed.ts skips everything when any");
  console.log("  district exists, and deploy.sh runs the seed on every deploy -- so");
  console.log("  removing them would reinstate all of this on the next deployment.\n");

  await getPool().end();
}

main().catch(async (err) => {
  console.error("[purge] failed:", err);
  try {
    await getPool().end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
