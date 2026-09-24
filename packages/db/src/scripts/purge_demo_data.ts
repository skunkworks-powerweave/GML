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
//   3. REAL WORK MAY ALREADY BE ATTACHED. If anyone has used a demo cycle for
//      a genuine observation -- easily done, they look real -- deleting it
//      cascades that work away. Every candidate is checked for attached
//      submissions, responses and meetings first, and anything with real work
//      is REPORTED AND KEPT rather than deleted.
//
// ── USE ──────────────────────────────────────────────────────────────────────
//
//   docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/purge_demo_data.ts
//       Dry run. Prints exactly what would go and what would be kept. Changes
//       nothing. This is the default deliberately.
//
//   ... purge_demo_data.ts --apply
//       Does it, in one transaction.
//
// Safe to run twice: the second run finds nothing and says so.

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
 */
const DEMO_SCHOOL_CODES = [
  "GPS-CHU", "GMS-KHA", "GHS-DSK", "GMS-DRS", "GHS-PDM",
  "GHS-KGL", "GMS-NYM", "GHS-LEH", "GPS-SNK", "GMS-SRG",
];
/** The seed's teachers all carry a mobile in this block. */
const DEMO_TEACHER_PHONE_PREFIX = "+91 94191000";
/** The seed's cycles are OBS-2026-001 .. OBS-2026-008. */
const DEMO_CYCLE_CODE_PREFIX = "OBS-2026-0";

type Row = Record<string, unknown>;
const rowsOf = async (q: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.execute(q)) as unknown as { rows: Row[] }).rows ?? [];

const n = (v: unknown): number => Number(v ?? 0);

/**
 * A parenthesised, parameterised value list for use with IN / NOT IN.
 *
 * Drizzle's sql`` does not bind a JS array as a Postgres array, so
 * `= ANY(${arr}::text[])` fails with 42846 "cannot cast type". Joining the
 * values into a real list keeps every one of them a bound parameter -- no
 * interpolation into the statement text.
 *
 * Never called with an empty array: each caller substitutes a sentinel first,
 * because `IN ()` is a syntax error.
 */
const valueList = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

async function main(): Promise<void> {
  console.log(APPLY ? "\n[purge] APPLYING\n" : "\n[purge] DRY RUN — nothing will be changed. Re-run with --apply to commit.\n");

  // ── What is here ───────────────────────────────────────────────────────────
  const schools = await rowsOf(sql`
    SELECT id, code, name FROM schools WHERE code IN (${valueList(DEMO_SCHOOL_CODES)})`);
  const teachers = await rowsOf(sql`
    SELECT id, full_name FROM teachers WHERE phone LIKE ${DEMO_TEACHER_PHONE_PREFIX + "%"}`);
  const cycles = await rowsOf(sql`
    SELECT id, code FROM observation_cycles WHERE code LIKE ${DEMO_CYCLE_CODE_PREFIX + "%"}`);

  if (schools.length === 0 && teachers.length === 0 && cycles.length === 0) {
    console.log("  Nothing to purge — no demo rows found. (Already done, or this is real data.)\n");
    await getPool().end();
    return;
  }

  console.log(`  demo schools  ${schools.length}`);
  console.log(`  demo teachers ${teachers.length}`);
  console.log(`  demo cycles   ${cycles.length}`);

  // ── Is there real work attached? ───────────────────────────────────────────
  //
  // A cycle someone has actually used is not demo data any more, whatever its
  // code says. Checked BEFORE anything is deleted, and such a cycle is kept.
  const usedCycles = await rowsOf(sql`
    SELECT c.id, c.code,
           (SELECT count(*) FROM observation_forms f WHERE f.cycle_id = c.id
              AND f.submitted_by_user_id IS NOT NULL)::int AS forms,
           (SELECT count(*) FROM video_submissions v WHERE v.context_id = c.id
              AND v.context_type = 'observation_cycle')::int AS videos,
           (SELECT count(*) FROM observation_evidence e WHERE e.cycle_id = c.id)::int AS evidence
    FROM observation_cycles c
    WHERE c.code LIKE ${DEMO_CYCLE_CODE_PREFIX + "%"}`);

  const keepCycleIds = usedCycles
    .filter((r) => n(r.forms) + n(r.videos) + n(r.evidence) > 0)
    .map((r) => String(r.id));

  if (keepCycleIds.length > 0) {
    console.log("\n  KEEPING these cycles — real work is attached to them:");
    for (const r of usedCycles) {
      if (!keepCycleIds.includes(String(r.id))) continue;
      console.log(`    ${r.code}  forms=${n(r.forms)} videos=${n(r.videos)} evidence=${n(r.evidence)}`);
    }
    console.log("    Review them by hand. Everything else below is still removed.");
  }

  // A teacher who has uploaded anything, or who has been given a login, is
  // likewise treated as real.
  const usedTeachers = await rowsOf(sql`
    SELECT t.id, t.full_name, t.user_id,
           (SELECT count(*) FROM video_submissions v
              JOIN users u ON u.id = v.submitted_by_user_id
              WHERE u.id = t.user_id)::int AS uploads
    FROM teachers t
    WHERE t.phone LIKE ${DEMO_TEACHER_PHONE_PREFIX + "%"}`);

  const keepTeacherIds = usedTeachers
    .filter((r) => r.user_id !== null || n(r.uploads) > 0)
    .map((r) => String(r.id));

  if (keepTeacherIds.length > 0) {
    console.log("\n  KEEPING these teachers — they have a login account or uploads:");
    for (const r of usedTeachers) {
      if (!keepTeacherIds.includes(String(r.id))) continue;
      console.log(`    ${r.full_name}  user_id=${r.user_id ? "set" : "null"} uploads=${n(r.uploads)}`);
    }
  }

  if (!APPLY) {
    console.log("\n  Dry run complete. Nothing was changed.");
    console.log("  Re-run with --apply to remove the rows listed above.\n");
    await getPool().end();
    return;
  }

  // ── Delete, children first ─────────────────────────────────────────────────
  //
  // One transaction: a purge that half-succeeds is worse than one that fails.
  await db.transaction(async (tx) => {
    const keptCycles = keepCycleIds.length ? keepCycleIds : ["00000000-0000-0000-0000-000000000000"];
    const keptTeachers = keepTeacherIds.length ? keepTeacherIds : ["00000000-0000-0000-0000-000000000000"];

    // Cycles first: they RESTRICT teacher deletion, and their forms, evidence
    // and drafts cascade away with them.
    await tx.execute(sql`
      DELETE FROM observation_cycles
      WHERE code LIKE ${DEMO_CYCLE_CODE_PREFIX + "%"} AND id NOT IN (${valueList(keptCycles)})`);

    // Pairings RESTRICT both mentors and teachers; meetings and feedback
    // responses cascade with them.
    await tx.execute(sql`
      DELETE FROM mentor_pairings
      WHERE teacher_id IN (
        SELECT id FROM teachers
        WHERE phone LIKE ${DEMO_TEACHER_PHONE_PREFIX + "%"} AND id NOT IN (${valueList(keptTeachers)}))`);

    // sessions.teacher_id is RESTRICT, so these must go before the teachers.
    await tx.execute(sql`
      DELETE FROM sessions
      WHERE teacher_id IN (
        SELECT id FROM teachers
        WHERE phone LIKE ${DEMO_TEACHER_PHONE_PREFIX + "%"} AND id NOT IN (${valueList(keptTeachers)}))`);

    await tx.execute(sql`
      DELETE FROM teachers
      WHERE phone LIKE ${DEMO_TEACHER_PHONE_PREFIX + "%"} AND id NOT IN (${valueList(keptTeachers)})`);

    // Mentors, once no pairing references them. Left alone if one survives.
    await tx.execute(sql`
      DELETE FROM mentors
      WHERE id NOT IN (SELECT mentor_id FROM mentor_pairings)
        AND name IN ('Dr. Anjali Bhatt', 'Rinchen Angmo')`);

    // Schools last: teachers RESTRICT them. classes, learners and remaining
    // sessions cascade.
    await tx.execute(sql`
      DELETE FROM schools
      WHERE code IN (${valueList(DEMO_SCHOOL_CODES)})
        AND id NOT IN (SELECT school_id FROM teachers)`);
  });

  // ── What is left ───────────────────────────────────────────────────────────
  const after = await rowsOf(sql`
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
