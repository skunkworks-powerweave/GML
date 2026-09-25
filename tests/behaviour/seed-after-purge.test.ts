// Deploy after a demo-data purge, executed.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// README-deploy.md 3.1 tells the IT team to run purge_demo_data.ts --apply on
// day one, to get the ten fictional teachers out before real staff sign in. The
// purge deletes every seed cycle (OBS-2026-001..008) with no real work attached -- and the
// three observation templates seed_forms_observation.ts writes onto
// OBS-2026-001 carry submitted_by_user_id = NULL, so they never count as real
// work, and OBS-2026-001 goes.
//
// seed_forms_observation.ts then treated a missing OBS-2026-001 as fatal:
// console.error + process.exit(1). seed.ts never recreates the cycle (it skips
// everything once any district exists, and the purge keeps the districts on
// purpose), deploy.sh runs seed_all.ts under `set -euo pipefail` on every
// deploy, and process.exit() inside a phase kills the orchestrator outright.
// So EVERY deploy after the documented purge exited 1 at the seed step, before
// verify-auth and the smoke check, with a message about running the seed first
// -- advice that cannot help, because the seed is exactly what just ran.
//
// ── AND THE PURGE ITSELF ─────────────────────────────────────────────────────
//
// The purge's "keep a demo cycle that has real work on it" path could never
// succeed. It kept the cycle but still deleted that cycle's teacher, and
// observation_cycles.teacher_id is ON DELETE RESTRICT -- so the single
// transaction died with SQLSTATE 23503 and rolled back, and the operator got a
// raw Postgres error from the one day-one step meant to be safe.
//
// ── AND WHAT IT CALLED DEMO DATA (F102) ──────────────────────────────────────
//
// It recognised demo cycles by `code LIKE 'OBS-2026-0%'` -- and /observation/new
// mints real codes as OBS-<year>-<max+1>, so every real cycle created in 2026
// matched, and any without submitted work yet was deleted. It deleted every
// pairing of an unlinked demo teacher together with that pairing's meetings and
// feedback responses, which the seed never writes: a real mentor's submitted
// feedback went with it. It deleted a demo-named mentor record even when a real
// login was linked to it. And the dry run printed counts, so none of that was
// visible before --apply.
//
// After that fix it still took a seed-coded cycle whose demo teacher record had
// since been given a login -- the teacher counted as real, their cycle did not
// -- and it let in-progress drafts cascade away with an idle pairing or cycle,
// including one saved while the purge was running. And the sessions, RTT
// marks, learners and classes it removes with the listed rows were named but
// never counted.
//
// ── HOW THESE TESTS RUN ──────────────────────────────────────────────────────
//
// Both scripts are executed as the operator runs them, in a child process.
//
// The seed test needs no database: "the anchor cycle is absent" is a query that
// returns no rows, which a fake server can answer (see _fake_pg.ts). It runs
// everywhere.
//
// The purge tests need real foreign keys, so they need a real Postgres -- and
// they run a script that deletes every row matching the seed's own literals, so
// they refuse to run against anything but a database on this machine. They
// live in this one file so that no two purges ever run at once: a purge in
// another process could delete this file's fixtures while they are being built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Client } from "pg";
import { startFakePg } from "./_fake_pg.js";
import { DATABASE_URL, connect, needsDatabase, tag, withClient } from "./_harness.js";

const here = fileURLToPath(import.meta.url);
const root = resolve(here, "..", "..", "..");
const SEED_OBS = resolve(root, "packages/db/src/scripts/seed_forms_observation.ts");
const PURGE = resolve(root, "packages/db/src/scripts/purge_demo_data.ts");
const TSX_LOADER = pathToFileURL(createRequire(here).resolve("tsx")).href;

type Run = { code: number | null; stdout: string; stderr: string };

/**
 * Run node with tsx in a scratch directory.
 *
 * The cwd has no .env in it and dotenv is pointed at a file that does not
 * exist, so the child can only ever dial the database it is handed here --
 * whatever .env happens to sit in the checkout the suite is run from.
 */
function runTsx(nodeArgs: string[], databaseUrl: string): Promise<Run> {
  const cwd = mkdtempSync(join(tmpdir(), "seed-after-purge-"));
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, ...nodeArgs], {
      cwd,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DOTENV_CONFIG_PATH: join(cwd, "no-such.env"),
        SEED_DRY_RUN: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("error", reject);
    child.on("close", (exit) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      done({ code: exit, stdout, stderr });
    });
  });
}

const show = (r: Run) => `--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;

// ── The seed step after a purge ──────────────────────────────────────────────

test("seed_forms_observation RETURNS when OBS-2026-001 is gone, so deploy.sh survives a purge", async () => {
  const pg = await startFakePg();
  try {
    // Imported and awaited, exactly as seed_all.ts does it. A process.exit()
    // anywhere on this path would take the orchestrator down with it.
    const code =
      `const m = await import(${JSON.stringify(pathToFileURL(SEED_OBS).href)});` +
      `await m.main();` +
      `console.log("MAIN_RETURNED");`;
    const run = await runTsx(["--input-type=module", "-e", code], pg.url);
    const out = show(run);

    // Prove the missing-anchor path is the one that actually ran, not a
    // connection failure that happens to look similar.
    assert.ok(
      pg.queries.some((q) => /from\s+"observation_cycles"/i.test(q)),
      `the anchor lookup never reached the server:\n${out}`,
    );

    assert.equal(
      run.code,
      0,
      "a missing OBS-2026-001 must not exit non-zero: deploy.sh runs seed_all.ts " +
        `under set -e, so this aborts every deploy after the documented purge.\n${out}`,
    );
    assert.match(
      run.stdout,
      /MAIN_RETURNED/,
      "main() must RETURN. seed_all.ts awaits it in-process, so a process.exit() " +
        `here kills the orchestrator before the remaining phases.\n${out}`,
    );
    assert.ok(
      !pg.queries.some((q) => /^\s*insert\b/i.test(q)),
      `nothing may be inserted when there is no cycle to attach it to:\n${pg.queries.join("\n")}`,
    );
    assert.match(
      run.stdout + run.stderr,
      /OBS-2026-001/,
      "the operator should still be told which cycle was missing and what was skipped",
    );
  } finally {
    await pg.close();
  }
});

// ── The purge's keep-real-work path ──────────────────────────────────────────

/** Only a database on this machine may have the purge run against it. */
function purgeSkip(): string | false {
  const needs = needsDatabase();
  if (needs) return needs;
  const host = new URL(DATABASE_URL!).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    return `purge_demo_data.ts --apply deletes every demo-pattern row; refusing to run it against ${host}`;
  }
  return false;
}

/**
 * The URL the purge child should use. purge_demo_data.ts goes through
 * @gml/db's client, which turns TLS on unless the URL says otherwise; the CI
 * service container and a local throwaway cluster do not speak TLS.
 */
function plainUrl(): string {
  const u = new URL(DATABASE_URL!);
  if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}


/**
 * What seed.ts writes, and so what the purge recognises: the ten teachers'
 * mobiles and the eight cycle codes. tests/governance/
 * test_data_purge_recognises_seed pins these lists to seed.ts.
 */
const SEED_PHONES = Array.from({ length: 10 }, (_, i) => `+91 94191000${String(i + 1).padStart(2, "0")}`);
const SEED_CYCLE_CODES = Array.from({ length: 8 }, (_, i) => `OBS-2026-${String(i + 1).padStart(3, "0")}`);
/** Codes /observation/new mints for a real 2026 cycle once the seed's exist. */
const MINTED_2026_CODES = Array.from({ length: 89 }, (_, i) => `OBS-2026-${String(i + 11).padStart(3, "0")}`);
/** The seed's school codes, which the purge also recognises. */
const SEED_SCHOOL_CODES = [
  "GPS-CHU", "GMS-KHA", "GHS-DSK", "GMS-DRS", "GHS-PDM",
  "GHS-KGL", "GMS-NYM", "GHS-LEH", "GPS-SNK", "GMS-SRG",
];

/**
 * `n` of `codes` that no row of `table` holds yet. observation_cycles.code and
 * schools.code are UNIQUE, and a row the purge is meant to recognise has to
 * carry one of the seed's codes -- so a database still holding the seed's own
 * rows cannot host these fixtures, and says so rather than failing on a
 * duplicate key.
 */
async function freeCodes(
  c: Client,
  codes: string[],
  n: number,
  table: "observation_cycles" | "schools" = "observation_cycles",
): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT code FROM unnest($1::text[]) WITH ORDINALITY AS u(code, i)
      WHERE code NOT IN (SELECT code FROM ${table}) ORDER BY i`,
    [codes],
  );
  assert.ok(rows.length >= n, `this test needs ${n} of ${codes[0]}..${codes.at(-1)} unused; ${rows.length} are free`);
  return rows.slice(0, n).map((r: { code: string }) => r.code);
}

/**
 * Committed rows, removed again children-first by `cleanup` (reverse creation
 * order). The purge runs in another process, so nothing here can be a
 * transaction that is rolled back. Rows the purge already removed make their
 * DELETE a no-op.
 */
function rows(c: Client) {
  const undo: Array<[string, string]> = [];
  return {
    async add(table: string, values: Record<string, unknown>): Promise<string> {
      const keys = Object.keys(values);
      const { rows: r } = await c.query(
        `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(", ")})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        keys.map((k) => values[k]),
      );
      undo.push([table, r[0].id]);
      return r[0].id as string;
    },
    async cleanup(): Promise<void> {
      for (const [table, id] of undo.reverse()) {
        await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]).catch((err: unknown) => {
          console.warn(`[purge test] cleanup of ${table} ${id} failed: ${String(err)}`);
        });
      }
    },
  };
}

const exists = async (c: Client, table: string, id: string) =>
  (await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

test(
  "purge --apply keeps a demo cycle with real work AND its teacher, and still removes the rest",
  { skip: purgeSkip() },
  async () => {
    const id = tag("pg").slice(-8);
    await withClient(async (c) => {
      const r = rows(c);
      try {
        // Shaped to match the purge's own recognisers -- the seed's teacher
        // mobiles and cycle codes -- and nothing else. The school is NOT a demo
        // school code, so the purge never considers it. Teachers are inactive
        // so no other suite that counts active teachers can see them.
        const [cycleKeep, cycleGone] = await freeCodes(c, SEED_CYCLE_CODES, 2);
        const d = await r.add("districts", { name: `Purge test ${id}`, code: `PT${id}` });
        const z = await r.add("zones", { district_id: d, name: "purge test zone" });
        const s = await r.add("schools", { zone_id: z, code: `PT-${id}`, name: "Purge test school" });
        const tk = await r.add("teachers", { school_id: s, full_name: `Purge keep ${id}`, phone: SEED_PHONES[0], active: false });
        const tg = await r.add("teachers", { school_id: s, full_name: `Purge gone ${id}`, phone: SEED_PHONES[1], active: false });
        const ck = await r.add("observation_cycles", { code: cycleKeep, teacher_id: tk, kind: "baseline" });
        const cg = await r.add("observation_cycles", { code: cycleGone, teacher_id: tg, kind: "baseline" });
        // Real work: one evidence row. This is what the purge's keep-filter
        // counts, and what makes it keep the cycle.
        await r.add("observation_evidence", { cycle_id: ck, caption: "real work" });
        // The removed teacher also has a pairing with nothing on it and an RTT
        // attendance mark. Those used to cascade; since migration 0031 they are
        // RESTRICT, so the purge has to remove them itself or roll back.
        const m = await r.add("mentors", { name: `Purge mentor ${id}` });
        const p = await r.add("mentor_pairings", { mentor_id: m, teacher_id: tg });
        const ph = await r.add("phases", { label: `PP ${id}`, sequence: 901 });
        const tm = await r.add("terms", { phase_id: ph, name: "Purge term", sequence: 1 });
        const rs = await r.add("rtt_subjects", { term_id: tm, name: "Purge subject" });
        const se = await r.add("rtt_sessions", { rtt_subject_id: rs, sequence: 1, title: "Purge webinar" });
        await r.add("rtt_attendance", { rtt_session_id: se, teacher_id: tg });

        const run = await runTsx([PURGE, "--apply"], plainUrl());
        const out = show(run);

        assert.doesNotMatch(
          run.stdout + run.stderr,
          /23503|violates foreign key/i,
          "keeping a cycle while deleting its teacher trips observation_cycles.teacher_id " +
            `ON DELETE RESTRICT and rolls the whole purge back:\n${out}`,
        );
        assert.equal(run.code, 0, `purge --apply must succeed:\n${out}`);
        assert.ok(await exists(c, "observation_cycles", ck), "the cycle with real work attached must be kept");
        assert.ok(
          await exists(c, "teachers", tk),
          "the teacher of a kept cycle must be kept -- the cycle cannot exist without them",
        );
        assert.ok(!(await exists(c, "observation_cycles", cg)), "a demo cycle with no real work must still be removed");
        assert.ok(!(await exists(c, "mentor_pairings", p)), "a demo pairing with nothing on it must still be removed");
        assert.ok(!(await exists(c, "teachers", tg)), "a demo teacher with nothing keeping them must still be removed");
      } finally {
        await r.cleanup();
      }
    });
  },
);

/**
 * Real programme data that looks like the seed's, beside demo data that is
 * exactly the seed's -- the situation a live database is in after a few weeks.
 */
async function realAndDemo(c: Client, r: ReturnType<typeof rows>, id: string) {
  const [demoCode, reusedCode, linkedCode, draftCycleCode] = await freeCodes(c, SEED_CYCLE_CODES, 4);
  const [mintedCode] = await freeCodes(c, MINTED_2026_CODES, 1);
  const [demoSchoolCode] = await freeCodes(c, SEED_SCHOOL_CODES, 1, "schools");
  const d = await r.add("districts", { name: `Purge real ${id}`, code: `PR${id}` });
  const z = await r.add("zones", { district_id: d, name: "purge real zone" });
  const s = await r.add("schools", { zone_id: z, code: `PR-${id}`, name: "Purge real school" });
  const login = await r.add("users", { id: randomUUID(), email: `mentor.${id}@example.test`, name: `Mentor ${id}`, role: "mentor" });
  const login2 = await r.add("users", { id: randomUUID(), email: `mentor2.${id}@example.test`, name: `Mentor2 ${id}`, role: "mentor" });

  // A real teacher and two real cycles nominated in 2026 with nothing
  // submitted yet: one numbered after the seed's, as /observation/new mints
  // it, and one that reuses a seed code, as it mints once the purge has
  // removed the seed's cycles.
  const real = await r.add("teachers", { school_id: s, full_name: `Real teacher ${id}`, phone: `+91 70000 ${id}`, active: false });
  const minted = await r.add("observation_cycles", { code: mintedCode, teacher_id: real, kind: "baseline" });
  const reused = await r.add("observation_cycles", { code: reusedCode, teacher_id: real, kind: "developmental" });

  // Demo teachers (the seed's mobiles), with work the seed never writes.
  const dFeedback = await r.add("teachers", { school_id: s, full_name: `Demo feedback ${id}`, phone: SEED_PHONES[2], active: false });
  const dMeeting = await r.add("teachers", { school_id: s, full_name: `Demo meeting ${id}`, phone: SEED_PHONES[3], active: false });
  const dIdle = await r.add("teachers", { school_id: s, full_name: `Demo idle ${id}`, phone: SEED_PHONES[4], active: false });

  // The seed's mentor names. One linked to a real login and paired, one
  // linked and unpaired, one plain one with a meeting, one plain and idle.
  const mLinked = await r.add("mentors", { name: "Dr. Anjali Bhatt", user_id: login });
  const mLinkedUnpaired = await r.add("mentors", { name: "Prof. Iqbal Hussain", user_id: login2 });
  const mMeeting = await r.add("mentors", { name: "Prof. Iqbal Hussain" });
  const mIdle = await r.add("mentors", { name: "Dr. Anjali Bhatt" });

  const form = await r.add("feedback_forms", { kind: "baseline", audience: "mentor", schema: "{}", version: `purge-${id}` });
  const pFeedback = await r.add("mentor_pairings", { mentor_id: mLinked, teacher_id: dFeedback });
  const response = await r.add("feedback_responses", {
    form_id: form,
    pairing_id: pFeedback,
    respondent_user_id: login,
    responses: '{"q1":"real feedback"}',
  });
  const pMeeting = await r.add("mentor_pairings", { mentor_id: mMeeting, teacher_id: dMeeting });
  const meeting = await r.add("mentor_meetings", { pairing_id: pMeeting, scheduled_at: new Date(), notes: "real meeting notes" });
  const pIdle = await r.add("mentor_pairings", { mentor_id: mIdle, teacher_id: dIdle });
  const idleCycle = await r.add("observation_cycles", { code: demoCode, teacher_id: dIdle, kind: "baseline" });

  // A demo teacher record a real teacher has since been given a login to (it
  // carries a seed mobile), with an idle cycle nominated for them that took a
  // free seed code. The login makes the teacher real, and their cycles with
  // them.
  const tLogin = await r.add("users", { id: randomUUID(), email: `teacher.${id}@example.test`, name: `Teacher ${id}`, role: "teacher" });
  const dLinked = await r.add("teachers", {
    school_id: s, full_name: `Demo linked ${id}`, phone: SEED_PHONES[5], user_id: tLogin, active: false,
  });
  const linkedCycle = await r.add("observation_cycles", { code: linkedCode, teacher_id: dLinked, kind: "baseline" });

  // In-progress drafts, which cascade with the pairing or cycle they sit on:
  // the linked mentor's half-written feedback on an otherwise idle pairing, and
  // an observer's draft on an otherwise idle demo cycle. A draft always
  // belongs to a login, and the seed writes none.
  const dDraft = await r.add("teachers", { school_id: s, full_name: `Demo draft ${id}`, phone: SEED_PHONES[6], active: false });
  const pDraft = await r.add("mentor_pairings", { mentor_id: mLinked, teacher_id: dDraft });
  const pairingDraft = await r.add("form_drafts", {
    user_id: login, template_id: form, pairing_id: pDraft, responses: '{"q1":"half-written feedback"}',
  });
  const dCycleDraft = await r.add("teachers", { school_id: s, full_name: `Demo cycle draft ${id}`, phone: SEED_PHONES[7], active: false });
  const draftCycle = await r.add("observation_cycles", { code: draftCycleCode, teacher_id: dCycleDraft, kind: "baseline" });
  const cycleDraft = await r.add("form_drafts", {
    user_id: login2, observation_cycle_id: draftCycle, responses: '{"notes":"half-written observation"}',
  });

  // What the purge removes along with the rows it lists, none of which the
  // seed writes: the idle cycle's unsubmitted template, the idle teacher's
  // classroom session and RTT attendance mark, and a demo school's class and
  // learner -- a child's record.
  const template = await r.add("observation_forms", { cycle_id: idleCycle, kind: "pre", responses: "{}" });
  const subject = await r.add("subjects", { name: `Purge subject ${id}`, code: `PS${id}` });
  const cls = await r.add("classes", { school_id: s, grade: 5, stage: "Primary" });
  const session = await r.add("sessions", {
    school_id: s, class_id: cls, subject_id: subject, teacher_id: dIdle, scheduled_date: "2026-09-01",
  });
  const ph = await r.add("phases", { label: `PR ${id}`, sequence: 902 });
  const tm = await r.add("terms", { phase_id: ph, name: "Purge real term", sequence: 1 });
  const rs = await r.add("rtt_subjects", { term_id: tm, name: "Purge real subject" });
  const se = await r.add("rtt_sessions", { rtt_subject_id: rs, sequence: 1, title: "Purge real webinar" });
  const attendance = await r.add("rtt_attendance", { rtt_session_id: se, teacher_id: dIdle });
  const ds = await r.add("schools", { zone_id: z, code: demoSchoolCode, name: `Demo school ${id}` });
  const dsClass = await r.add("classes", { school_id: ds, grade: 3, stage: "Primary" });
  const learner = await r.add("learners", { class_id: dsClass, school_id: ds, grade: 3, name: `Learner ${id}` });

  return {
    demoCode, mintedCode, reusedCode, linkedCode, draftCycleCode, demoSchoolCode,
    keep: {
      minted, reused, real, dFeedback, dMeeting, mLinked, mLinkedUnpaired, mMeeting, pFeedback, pMeeting, response, meeting,
      dLinked, linkedCycle, dDraft, pDraft, pairingDraft, dCycleDraft, draftCycle, cycleDraft,
    },
    gone: { idleCycle, pIdle, dIdle, mIdle, template, session, attendance, ds, dsClass, learner },
  };
}

test(
  "purge dry run lists every cycle, pairing, teacher and mentor it would remove, and removes nothing",
  { skip: purgeSkip() },
  async () => {
    const id = tag("pd").slice(-8);
    await withClient(async (c) => {
      const r = rows(c);
      try {
        const w = await realAndDemo(c, r, id);
        const run = await runTsx([PURGE], plainUrl());
        const out = show(run);
        assert.equal(run.code, 0, `the dry run must succeed:\n${out}`);

        // The operator decides from this listing whether to --apply, so it has
        // to name each row, not count them. What follows "KEPT" is kept.
        const [removed = "", kept = ""] = run.stdout.split(/^\s*KEPT\b/m);
        for (const [what, needle] of [
          ["the idle demo cycle's code", w.demoCode],
          ["the idle demo pairing", w.gone.pIdle],
          ["the idle demo teacher", `Demo idle ${id}`],
          ["the idle demo mentor", w.gone.mIdle],
        ]) {
          assert.ok(removed.includes(needle!), `the dry run must list ${what} (${needle}) as removed:\n${out}`);
        }
        for (const [what, needle] of [
          ["the real teacher's minted cycle", w.mintedCode],
          ["the real teacher's cycle that reuses a seed code", w.reusedCode],
          ["the pairing with a real mentor's feedback", w.keep.pFeedback],
          ["the pairing with a meeting", w.keep.pMeeting],
          ["the demo-named mentor linked to a real login", w.keep.mLinkedUnpaired],
          ["the cycle of a demo teacher record that has a login", w.linkedCode],
          ["the pairing with a mentor's draft on it", w.keep.pDraft],
          ["the cycle with an observer's draft on it", w.draftCycleCode],
        ]) {
          assert.ok(!removed.includes(needle!), `the dry run lists ${what} (${needle}) as removed:\n${out}`);
        }
        assert.ok(kept.includes(w.keep.pFeedback), `the dry run must say which pairings it keeps, and why:\n${out}`);
        assert.match(
          kept,
          new RegExp(`${w.keep.pDraft}.*drafts=1`),
          `the dry run must say a pairing is kept for the draft on it:\n${out}`,
        );
        assert.match(
          kept,
          new RegExp(`${w.draftCycleCode}.*drafts=1`),
          `the dry run must say a cycle is kept for the draft on it:\n${out}`,
        );

        // Rows the listed ones take with them are counted, table by table, so
        // "the demo schools' classes" cannot hide a school's children.
        for (const [what, label] of [
          ["the idle cycle's unsubmitted template", "observation form templates"],
          ["the idle teacher's classroom session", "classroom sessions"],
          ["the idle teacher's RTT attendance mark", "RTT attendance marks"],
          ["the demo school's learner", "learners"],
          ["the demo school's class", "classes"],
        ]) {
          assert.match(
            removed,
            new RegExp(`^\\s*${label}\\s+1\\b`, "m"),
            `the dry run must count ${what} among the rows removed ("${label}  1"):\n${out}`,
          );
        }

        for (const [table, rowId] of [
          ["observation_cycles", w.gone.idleCycle], ["mentor_pairings", w.gone.pIdle], ["teachers", w.gone.dIdle],
          ["mentors", w.gone.mIdle], ["sessions", w.gone.session], ["learners", w.gone.learner],
        ]) {
          assert.ok(await exists(c, table!, rowId!), `a dry run must change nothing, but ${table} ${rowId} is gone`);
        }
      } finally {
        await r.cleanup();
      }
    });
  },
);

test(
  "purge --apply keeps real programme data that only resembles the seed's, and still removes the seed's",
  { skip: purgeSkip() },
  async () => {
    const id = tag("pr").slice(-8);
    await withClient(async (c) => {
      const r = rows(c);
      try {
        const w = await realAndDemo(c, r, id);
        const run = await runTsx([PURGE, "--apply"], plainUrl());
        const out = show(run);
        assert.equal(run.code, 0, `purge --apply must succeed:\n${out}`);

        const kept: Array<[string, string, string]> = [
          ["observation_cycles", w.keep.minted, `a real teacher's 2026 cycle ${w.mintedCode} (minted after the seed's)`],
          ["observation_cycles", w.keep.reused, `a real teacher's cycle ${w.reusedCode} (a seed code, re-minted after a purge)`],
          ["teachers", w.keep.real, "the real teacher"],
          ["feedback_responses", w.keep.response, "a real mentor's submitted feedback on a demo teacher's pairing"],
          ["mentor_pairings", w.keep.pFeedback, "the pairing that feedback belongs to"],
          ["teachers", w.keep.dFeedback, "that pairing's teacher (the pairing cannot outlive them)"],
          ["mentors", w.keep.mLinked, "that pairing's mentor, a demo name linked to a real login"],
          ["mentor_meetings", w.keep.meeting, "a recorded mentor meeting on a demo pairing"],
          ["mentor_pairings", w.keep.pMeeting, "the pairing that meeting belongs to"],
          ["teachers", w.keep.dMeeting, "that pairing's teacher"],
          ["mentors", w.keep.mMeeting, "that pairing's mentor"],
          ["mentors", w.keep.mLinkedUnpaired, "a demo-named mentor record linked to a real login"],
          ["teachers", w.keep.dLinked, "a demo teacher record that has been given a login"],
          ["observation_cycles", w.keep.linkedCycle, `that teacher's idle cycle ${w.linkedCode}`],
          ["form_drafts", w.keep.pairingDraft, "a mentor's draft on an otherwise idle demo pairing"],
          ["mentor_pairings", w.keep.pDraft, "the pairing that draft is on"],
          ["teachers", w.keep.dDraft, "that pairing's teacher"],
          ["form_drafts", w.keep.cycleDraft, "an observer's draft on an otherwise idle demo cycle"],
          ["observation_cycles", w.keep.draftCycle, `the cycle ${w.draftCycleCode} that draft is on`],
          ["teachers", w.keep.dCycleDraft, "that cycle's teacher"],
        ];
        for (const [table, rowId, what] of kept) {
          assert.ok(await exists(c, table, rowId), `${what} must be kept, but ${table} ${rowId} was deleted:\n${out}`);
        }
        const gone: Array<[string, string, string]> = [
          ["observation_cycles", w.gone.idleCycle, `the demo cycle ${w.demoCode} with nothing on it`],
          ["mentor_pairings", w.gone.pIdle, "a demo pairing with nothing on it"],
          ["teachers", w.gone.dIdle, "a demo teacher with nothing keeping them"],
          ["mentors", w.gone.mIdle, "a demo mentor with no login and no pairing left"],
          ["observation_forms", w.gone.template, "the idle demo cycle's unsubmitted template"],
          ["sessions", w.gone.session, "the removed teacher's classroom session"],
          ["rtt_attendance", w.gone.attendance, "the removed teacher's RTT attendance mark"],
          ["learners", w.gone.learner, "the demo school's learner"],
          ["classes", w.gone.dsClass, "the demo school's class"],
          ["schools", w.gone.ds, `the demo school ${w.demoSchoolCode}, which no teacher is left in`],
        ];
        for (const [table, rowId, what] of gone) {
          assert.ok(!(await exists(c, table, rowId)), `${what} must still be removed:\n${out}`);
        }
      } finally {
        await r.cleanup();
      }
    });
  },
);

/** Poll `check` until it holds, or give up after `ms`. */
async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

test(
  "purge --apply stops, rather than take it, when a draft is saved on a listed pairing while it runs",
  { skip: purgeSkip() },
  async () => {
    const id = tag("pw").slice(-8);
    await withClient(async (c) => {
      const r = rows(c);
      // A second session plays the mentor's browser, autosaving a draft.
      const mentorSession = await connect();
      let draft: string | undefined;
      try {
        const d = await r.add("districts", { name: `Purge race ${id}`, code: `PW${id}` });
        const z = await r.add("zones", { district_id: d, name: "purge race zone" });
        const s = await r.add("schools", { zone_id: z, code: `PW-${id}`, name: "Purge race school" });
        const login = await r.add("users", { id: randomUUID(), email: `race.${id}@example.test`, name: `Race ${id}`, role: "mentor" });
        const t = await r.add("teachers", { school_id: s, full_name: `Purge race ${id}`, phone: SEED_PHONES[0], active: false });
        const m = await r.add("mentors", { name: `Purge race mentor ${id}` });
        const p = await r.add("mentor_pairings", { mentor_id: m, teacher_id: t });
        const form = await r.add("feedback_forms", { kind: "baseline", audience: "mentor", schema: "{}", version: `race-${id}` });

        // The draft is inserted but not yet committed when the purge starts, so
        // the purge's plan cannot see it and lists the pairing as idle. Its
        // foreign-key check holds a KEY SHARE lock on the pairing row until it
        // commits, which is what the purge then has to wait on.
        await mentorSession.query("BEGIN");
        const ins = await mentorSession.query(
          `INSERT INTO form_drafts (user_id, template_id, pairing_id, responses)
           VALUES ($1, $2, $3, '{"q1":"typed while the purge ran"}') RETURNING id`,
          [login, form, p],
        );
        draft = ins.rows[0].id as string;
        const mentorPid = (await mentorSession.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;

        const purge = runTsx([PURGE, "--apply"], plainUrl());
        const blocked = await waitFor(
          async () =>
            (await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [mentorPid]))
              .rows[0].n > 0,
          30_000,
        );
        await mentorSession.query("COMMIT");
        const run = await purge;
        const out = show(run);
        assert.ok(blocked, `the purge never reached the pairing the draft is on:\n${out}`);

        assert.ok(
          await exists(c, "form_drafts", draft),
          "a draft saved while the purge ran must not cascade away with a pairing the plan called idle -- " +
            `it was deleted:\n${out}`,
        );
        assert.ok(await exists(c, "mentor_pairings", p), `the pairing the draft is on must be kept:\n${out}`);
        assert.notEqual(run.code, 0, `the purge must fail rather than remove less than, or other than, it listed:\n${out}`);
        assert.match(run.stdout + run.stderr, /draft/i, `the operator must be told a draft stopped the purge:\n${out}`);
      } finally {
        await mentorSession.query("ROLLBACK").catch(() => undefined);
        await mentorSession.end().catch(() => undefined);
        if (draft) await c.query("DELETE FROM form_drafts WHERE id = $1", [draft]).catch(() => undefined);
        await r.cleanup();
      }
    });
  },
);
