// The audit lookups two admin pages run on every load read a bounded number of
// rows, however large audit_log grows.
//
// ── THE DEFECT (F108) ────────────────────────────────────────────────────────
//
// audit_log is append-only and never pruned. Two lookups grew with it:
//   /admin/audit            built its action filter with
//                           SELECT DISTINCT action ... WHERE created_at >= now() - 90 days,
//                           which reads every row of the last 90 days (1.9 s at
//                           2M rows). The 90-day bound caps age, not cost.
//   /admin/system-settings  looked up the latest `action LIKE 'backup.%'` and
//                           `'restore.%'` row. The database collation is
//                           en_US.UTF-8, so the (action, created_at) btree
//                           cannot serve a LIKE prefix, and as nothing writes
//                           those actions yet, both read the whole table
//                           (1.25 s at 2M rows), twice per render.
//
// Measured with Postgres's own per-transaction counters: the rows a lookup
// read from audit_log and its indexes (pg_stat_get_xact_tuples_returned), over
// thousands of rows inserted -- and ANALYZEd, so the planner plans for them --
// inside a transaction that is rolled back. Each lookup runs once to settle
// (an earlier rolled-back run leaves dead index entries that the first scan
// over them marks dead) and is measured on the second run, which is what every
// later page load costs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import { needsDatabase, tag, withClient } from "./_harness.js";

const skip = needsDatabase();
const lookups = () => import("../../apps/web/src/admin/audit-lookups.ts");

/** Rows read from audit_log so far in this transaction: sequentially, and through any of its indexes. */
async function readsSoFar(c: Client): Promise<number> {
  const { rows } = await c.query(`
    SELECT pg_stat_get_xact_tuples_returned('audit_log'::regclass)
         + coalesce((SELECT sum(pg_stat_get_xact_tuples_returned(indexrelid))
                       FROM pg_index WHERE indrelid = 'audit_log'::regclass), 0) AS n`);
  return Number(rows[0].n);
}

/** Run `fn` twice; return its second result and the rows that run read. */
async function measured<T>(c: Client, fn: () => Promise<T>): Promise<{ result: T; read: number }> {
  await fn();
  const before = await readsSoFar(c);
  const result = await fn();
  return { result, read: (await readsSoFar(c)) - before };
}

const BULK = 4000;

async function withBulkAudit(body: (c: Client, t: string) => Promise<void>): Promise<void> {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const t = tag("alk");
      await c.query(
        `INSERT INTO audit_log (action, entity_type, created_at)
         SELECT $1, 'test', now() - make_interval(mins => g) FROM generate_series(1, $3::int) g
         UNION ALL
         SELECT $2, 'test', now() - interval '200 days' - make_interval(mins => g) FROM generate_series(1, $3::int) g`,
        [`${t}.recent`, `${t}.old`, BULK],
      );
      await c.query("ANALYZE audit_log");
      await body(c, t);
    } finally {
      await c.query("ROLLBACK");
    }
  });
}

test("the /admin/audit action filter reads a few rows per action, not every row of 90 days", { skip }, async () => {
  const { recentAuditActions } = await lookups();
  await withBulkAudit(async (c, t) => {
    const db = drizzle(c);
    const { rows } = await c.query(`SELECT count(DISTINCT action)::int AS k FROM audit_log`);
    const distinct = rows[0].k as number;

    const { result, read } = await measured(c, () => recentAuditActions(90, db));
    assert.ok(result.includes(`${t}.recent`), "an action recorded in the last 90 days must be offered");
    assert.ok(!result.includes(`${t}.old`), "an action last recorded 200 days ago must not be offered");
    assert.deepEqual(result, [...result].sort(), "the options stay in alphabetical order");
    assert.ok(
      read <= 3 * distinct + 20,
      `building the filter read ${read} rows for ${distinct} distinct actions -- it must cost a few ` +
        `index probes per action, not a pass over the ${BULK} rows of the last 90 days`,
    );
  });
});

test("the backup and restore status reads the latest successful run from an index", { skip }, async () => {
  const { lastAuditAt } = await lookups();
  await withBulkAudit(async (c) => {
    const db = drizzle(c);
    const at = async (action: string, ago: string) =>
      (await c.query(`INSERT INTO audit_log (action, entity_type, created_at) VALUES ($1, 'test', now() - $2::interval) RETURNING created_at`, [action, ago])).rows[0].created_at as Date;
    await at("backup.complete", "2 days");
    const lastBackup = await at("backup.complete", "1 day");
    await at("backup.failed", "1 hour"); // a failed run is not a successful backup
    const lastDrill = await at("restore.complete", "3 days");

    for (const [kind, expected] of [["backup", lastBackup], ["restore", lastDrill]] as const) {
      const { result, read } = await measured(c, () => lastAuditAt(kind, db));
      assert.equal(
        result?.getTime(),
        expected.getTime(),
        `the ${kind} status must show the latest ${kind}.complete row -- not a later ${kind}.failed`,
      );
      assert.ok(
        read <= 5,
        `looking up the last ${kind} read ${read} rows of audit_log; a LIKE prefix cannot use the ` +
          "(action, created_at) index under en_US collation, so it scans the table on every render",
      );
    }
  });
});
