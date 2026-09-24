// The nightly retention sweep's rate_limits prune, executed.
//
// rate_limits keys carry the caller's IP (`login-link:<ip>`,
// `gate:<ip>:<userId>:<section>`). pruneRateLimits() existed, claimed to run
// nightly, and had no caller, so every row was permanent. This runs the prune
// the worker now calls and checks it removes exactly the counters whose window
// is long gone -- and nothing a live limiter still depends on.
//
// Wiring (that the worker's nightly job calls this) is pinned in
// tests/governance/test_data_rate_limits_pruned.test.mjs; running a real worker
// here would claim other suites' transcode jobs mid-test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { DATABASE_URL, needsDatabase, tag } from "./_harness.js";

const skip = needsDatabase();

test("pruneRateLimits removes counters whose window aged out, and keeps live ones", { skip }, async () => {
  // Imported here, not at the top: @gml/db's client builds its pool at import
  // and throws without DATABASE_URL, which would fail this file instead of
  // skipping it on a machine with no database.
  const { pruneRateLimits } = await import("@gml/db/scripts/retention");

  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const db = drizzle(pool);
  const t = tag("rl");
  const expired = `${t}:expired`;
  const recent = `${t}:23h`;
  const live = `${t}:live`;
  try {
    await pool.query(
      `INSERT INTO rate_limits (key, window_start, count) VALUES
         ($1, now() - interval '25 hours', 3),
         ($2, now() - interval '23 hours', 1),
         ($3, now(), 5)`,
      [expired, recent, live],
    );

    const n = await pruneRateLimits(24, db);
    assert.ok(n >= 1, `the prune reported ${n} rows deleted; the expired counter at least should have gone`);

    const { rows } = await pool.query(
      `SELECT key FROM rate_limits WHERE key = ANY($1::text[]) ORDER BY key`,
      [[expired, recent, live]],
    );
    assert.deepEqual(
      rows.map((r: { key: string }) => r.key).sort(),
      [live, recent].sort(),
      "a counter 25 hours past its window start must be deleted (it holds a client IP and " +
        "gates nothing); one 23 hours old and one live must be left alone",
    );
  } finally {
    await pool.query(`DELETE FROM rate_limits WHERE key LIKE $1`, [`${t}:%`]);
    await pool.end();
  }
});
