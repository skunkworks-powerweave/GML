// Deploy after a demo-data purge, executed.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// README-deploy.md 3.1 tells the IT team to run purge_demo_data.ts --apply on
// day one, to get the ten fictional teachers out before real staff sign in. The
// purge deletes every OBS-2026-0xx cycle with no real work attached -- and the
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
// ── HOW THESE TESTS RUN ──────────────────────────────────────────────────────
//
// Both scripts are executed as the operator runs them, in a child process.
//
// The seed test needs no database: "the anchor cycle is absent" is a query that
// returns no rows, which a fake server can answer (see _fake_pg.ts). It runs
// everywhere.
//
// The purge test needs real foreign keys, so it needs a real Postgres -- and it
// runs a script that deletes every row matching the seed's demo patterns, so it
// refuses to run against anything but a database on this machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakePg } from "./_fake_pg.js";
import { DATABASE_URL, needsDatabase, tag, withClient } from "./_harness.js";

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
    // sslmode=disable: the seeds now negotiate TLS as client.ts does, and this
    // fake speaks none (tests/behaviour/db-tls.test.ts relies on exactly that).
    const run = await runTsx(["--input-type=module", "-e", code], `${pg.url}?sslmode=disable`);
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

test(
  "purge --apply keeps a demo cycle with real work AND its teacher, and still removes the rest",
  { skip: purgeSkip() },
  async () => {
    const id = tag("pg").slice(-8);
    // Shaped to match the purge's own recognisers -- the teacher phone prefix
    // and the cycle code prefix -- and nothing else. The school is NOT a demo
    // school code, so the purge never considers it. Teachers are inactive so
    // no other suite that counts active teachers can see them.
    const phoneKeep = `+91 94191000-${id}-k`;
    const phoneGone = `+91 94191000-${id}-g`;
    const cycleKeep = `OBS-2026-0-${id}-k`;
    const cycleGone = `OBS-2026-0-${id}-g`;
    const schoolCode = `PT-${id}`;
    const districtCode = `PT${id}`;

    await withClient(async (c) => {
      const d = await c.query(
        `INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`,
        [`Purge test ${id}`, districtCode],
      );
      const z = await c.query(
        `INSERT INTO zones (district_id, name) VALUES ($1, 'purge test zone') RETURNING id`,
        [d.rows[0].id],
      );
      const s = await c.query(
        `INSERT INTO schools (zone_id, code, name) VALUES ($1, $2, 'Purge test school') RETURNING id`,
        [z.rows[0].id, schoolCode],
      );
      const insTeacher = (phone: string) =>
        c.query(
          `INSERT INTO teachers (school_id, full_name, phone, active)
           VALUES ($1, 'Purge test teacher', $2, false) RETURNING id`,
          [s.rows[0].id, phone],
        );
      const tk = await insTeacher(phoneKeep);
      const tg = await insTeacher(phoneGone);
      const ck = await c.query(
        `INSERT INTO observation_cycles (code, teacher_id, kind) VALUES ($1, $2, 'baseline') RETURNING id`,
        [cycleKeep, tk.rows[0].id],
      );
      await c.query(
        `INSERT INTO observation_cycles (code, teacher_id, kind) VALUES ($1, $2, 'baseline')`,
        [cycleGone, tg.rows[0].id],
      );
      // Real work: one evidence row. This is what the purge's keep-filter
      // counts, and what makes it keep the cycle.
      await c.query(
        `INSERT INTO observation_evidence (cycle_id, caption) VALUES ($1, 'real work')`,
        [ck.rows[0].id],
      );
      // The removed teacher also has a pairing with a meeting and an RTT
      // attendance mark. Those used to cascade; since migration 0031 they are
      // RESTRICT, so the purge has to remove them itself or roll back.
      const m = await c.query(`INSERT INTO mentors (name) VALUES ($1) RETURNING id`, [`Purge mentor ${id}`]);
      const p = await c.query(
        `INSERT INTO mentor_pairings (mentor_id, teacher_id) VALUES ($1, $2) RETURNING id`,
        [m.rows[0].id, tg.rows[0].id],
      );
      await c.query(`INSERT INTO mentor_meetings (pairing_id, scheduled_at) VALUES ($1, now())`, [p.rows[0].id]);
      const ph = await c.query(`INSERT INTO phases (label, sequence) VALUES ($1, 901) RETURNING id`, [`PP ${id}`]);
      const tm = await c.query(
        `INSERT INTO terms (phase_id, name, sequence) VALUES ($1, 'Purge term', 1) RETURNING id`,
        [ph.rows[0].id],
      );
      const rs = await c.query(
        `INSERT INTO rtt_subjects (term_id, name) VALUES ($1, 'Purge subject') RETURNING id`,
        [tm.rows[0].id],
      );
      const se = await c.query(
        `INSERT INTO rtt_sessions (rtt_subject_id, sequence, title) VALUES ($1, 1, 'Purge webinar') RETURNING id`,
        [rs.rows[0].id],
      );
      await c.query(`INSERT INTO rtt_attendance (rtt_session_id, teacher_id) VALUES ($1, $2)`, [
        se.rows[0].id,
        tg.rows[0].id,
      ]);
    });

    try {
      const run = await runTsx([PURGE, "--apply"], plainUrl());
      const out = show(run);

      assert.doesNotMatch(
        run.stdout + run.stderr,
        /23503|violates foreign key/i,
        "keeping a cycle while deleting its teacher trips observation_cycles.teacher_id " +
          `ON DELETE RESTRICT and rolls the whole purge back:\n${out}`,
      );
      assert.equal(run.code, 0, `purge --apply must succeed:\n${out}`);

      await withClient(async (c) => {
        const has = async (q: string, v: string) => (await c.query(q, [v])).rowCount === 1;
        assert.ok(
          await has(`SELECT 1 FROM observation_cycles WHERE code = $1`, cycleKeep),
          "the cycle with real work attached must be kept",
        );
        assert.ok(
          await has(`SELECT 1 FROM teachers WHERE phone = $1`, phoneKeep),
          "the teacher of a kept cycle must be kept -- the cycle cannot exist without them",
        );
        assert.ok(
          !(await has(`SELECT 1 FROM observation_cycles WHERE code = $1`, cycleGone)),
          "a demo cycle with no real work must still be removed",
        );
        assert.ok(
          !(await has(`SELECT 1 FROM teachers WHERE phone = $1`, phoneGone)),
          "a demo teacher with nothing keeping them must still be removed",
        );
      });
    } finally {
      // Children first: since migration 0031 evidence -> cycle and zone ->
      // district are ON DELETE RESTRICT, so nothing here cascades any more.
      await withClient(async (c) => {
        await c.query(
          `DELETE FROM observation_evidence WHERE cycle_id IN (SELECT id FROM observation_cycles WHERE code IN ($1, $2))`,
          [cycleKeep, cycleGone],
        );
        await c.query(`DELETE FROM observation_cycles WHERE code IN ($1, $2)`, [cycleKeep, cycleGone]);
        const mine = `(SELECT id FROM teachers WHERE phone IN ($1, $2))`;
        await c.query(`DELETE FROM rtt_attendance WHERE teacher_id IN ${mine}`, [phoneKeep, phoneGone]);
        await c.query(
          `DELETE FROM mentor_meetings WHERE pairing_id IN (SELECT id FROM mentor_pairings WHERE teacher_id IN ${mine})`,
          [phoneKeep, phoneGone],
        );
        await c.query(`DELETE FROM mentor_pairings WHERE teacher_id IN ${mine}`, [phoneKeep, phoneGone]);
        await c.query(`DELETE FROM mentors WHERE name = $1`, [`Purge mentor ${id}`]);
        await c.query(`DELETE FROM rtt_sessions WHERE title = 'Purge webinar' AND rtt_subject_id IN (SELECT s.id FROM rtt_subjects s JOIN terms t ON t.id = s.term_id JOIN phases p ON p.id = t.phase_id WHERE p.label = $1)`, [`PP ${id}`]);
        await c.query(`DELETE FROM rtt_subjects WHERE term_id IN (SELECT t.id FROM terms t JOIN phases p ON p.id = t.phase_id WHERE p.label = $1)`, [`PP ${id}`]);
        await c.query(`DELETE FROM terms WHERE phase_id IN (SELECT id FROM phases WHERE label = $1)`, [`PP ${id}`]);
        await c.query(`DELETE FROM phases WHERE label = $1`, [`PP ${id}`]);
        await c.query(`DELETE FROM teachers WHERE phone IN ($1, $2)`, [phoneKeep, phoneGone]);
        await c.query(`DELETE FROM schools WHERE code = $1`, [schoolCode]);
        await c.query(
          `DELETE FROM zones WHERE district_id IN (SELECT id FROM districts WHERE code = $1)`,
          [districtCode],
        );
        await c.query(`DELETE FROM districts WHERE code = $1`, [districtCode]);
      });
    }
  },
);
