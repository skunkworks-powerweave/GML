// The audit row backup.sh and restore.sh write, through the real psql, read
// back by the real /admin/system-settings lookup.
//
// ── THE DEFECT (W3-51) ───────────────────────────────────────────────────────
//
// /admin/system-settings shows the latest backup.complete and restore.complete
// rows in audit_log (apps/web/src/admin/audit-lookups.ts), and neither script
// wrote any: each recorded its last run only in a file on the host. So the
// panel could never show a real time -- nor show that backups had stopped.
//
// tests/scripts/backup-sh.test.mjs and restore-sh.test.mjs run the scripts
// against a stub psql and pin WHEN each row is written. A stub cannot say
// whether the SQL is valid, or whether psql's `:'var'` quoting really keeps a
// value out of the statement; this runs scripts/lib/audit-host-job.sh with the
// real psql against a scratch copy of audit_log (reached through the
// search_path, as every query the application makes is) and reads it back with
// the lookup the page uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { DATABASE_URL, needsDatabase, tag } from "./_harness.js";
import { bashExe, posixish } from "../scripts/_sandbox.mjs";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const HELPER = posixish(resolve(root, "scripts/lib/audit-host-job.sh"));

function psqlOnPath(): boolean {
  if (needsDatabase()) return false;
  return spawnSync(bashExe(), ["-c", "command -v psql"], { encoding: "utf8" }).status === 0;
}

/** audit_host_job <action> <meta>, as backup.sh and restore.sh call it. */
function auditHostJob(url: string, action: string, meta: string) {
  return spawnSync(bashExe(), ["-c", '. "$0"; audit_host_job "$1" "$2"', HELPER, action, meta], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, DATABASE_URL: url, PGPASSWORD: "the-drill-server-password" },
  });
}

test(
  "audit_host_job writes the row /admin/system-settings reads, and psql keeps every value out of the SQL",
  { skip: needsDatabase() || (!psqlOnPath() && "no psql on PATH") },
  async () => {
    const schema = tag("hostjob").replace(/-/g, "_");
    const admin = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
    await admin.connect();
    const sep = DATABASE_URL!.includes("?") ? "&" : "?";
    const url = `${DATABASE_URL}${sep}options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
    const world = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`CREATE TABLE ${schema}.audit_log (LIKE public.audit_log INCLUDING ALL)`);
      await world.connect();
      const rows = async () =>
        (
          await admin.query(
            `SELECT user_id, action, entity_type, entity_id, metadata, created_at FROM ${schema}.audit_log ORDER BY created_at`,
          )
        ).rows;

      const meta = { dump: "gml-20260925T020000Z.dump.gz", bytes: 123456, storage_mirrored: true, shipped_offsite: false };
      const ok = auditHostJob(url, "backup.complete", JSON.stringify(meta));
      assert.equal(ok.status, 0, ok.stderr);
      assert.doesNotMatch(ok.stderr, /WARNING/, `the write must succeed against a real audit_log:\n${ok.stderr}`);
      const [row] = await rows();
      assert.deepEqual(
        { ...row, created_at: undefined },
        { user_id: null, action: "backup.complete", entity_type: "host_job", entity_id: null, metadata: meta, created_at: undefined },
      );

      const { lastAuditAt } = await import("../../apps/web/src/admin/audit-lookups.ts");
      const shown = await lastAuditAt("backup", drizzle(world));
      assert.equal(
        shown?.getTime(),
        (row.created_at as Date).getTime(),
        "the Backup & restore panel must show the time of the run the script recorded",
      );

      // A value psql must quote: an apostrophe, and a statement after it.
      const hostile = "it's'); DROP TABLE audit_log; --";
      const quoted = auditHostJob(url, "backup.failed", JSON.stringify({ error: hostile }));
      assert.equal(quoted.status, 0, quoted.stderr);
      const after = await rows();
      assert.equal(after.length, 2, "the table is intact and holds both rows");
      assert.equal(after[1].metadata.error, hostile, "the value was stored as data, verbatim");

      // A write that fails is a warning, and the job's exit status is its own.
      const bad = auditHostJob(url, "backup.failed", "{not json");
      assert.equal(bad.status, 0, "a failed audit write must never fail the backup or the drill");
      assert.match(bad.stderr, /WARNING: could not record backup\.failed in the audit log/);
    } finally {
      await world.end().catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await admin.end();
    }
  },
);
