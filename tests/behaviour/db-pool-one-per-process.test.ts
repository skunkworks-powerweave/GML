// One Postgres pool per process, however many copies of @gml/db's client the
// process loads.
//
// ── THE DEFECT (GML-Staging builds #6 and #7, 9 Oct 2026) ────────────────────
//
// The deploy's migrate run was refused: "(EMAXCONNSESSION) max clients reached
// in session mode - max clients are limited to pool_size: 15". The Next.js
// production build puts packages/db/src/client.ts into several server chunks,
// and each copy the server loaded kept its own pool, so the app's DB_POOL_MAX
// (8) limited each copy rather than the process. A local production server
// with DB_POOL_MAX=10 held 13 connections under load. With the worker's 4 that
// filled Supabase's session pooler, and the deploy had nowhere to connect.
//
// Executed: two genuinely separate instances of the module (one URL each), a
// real Postgres, and concurrent queries through both.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
const CLIENT = pathToFileURL(resolve(import.meta.dirname, "..", "..", "packages", "db", "src", "client.ts")).href;

type ClientModule = typeof import("../../packages/db/src/client.ts");

test("two copies of the client module share one pool, so DB_POOL_MAX caps the whole process", { skip }, async () => {
  // Before either copy creates the pool (each creates it on import, via `db`).
  process.env.DB_POOL_MAX = "2";
  const a: ClientModule = await import(`${CLIENT}?copy=a`);
  const b: ClientModule = await import(`${CLIENT}?copy=b`);
  assert.notEqual(a, b, "the test must load two separate copies of the module, as the server build does");
  assert.notEqual(a.getDb, b.getDb, "...with their own functions and variables");

  const pool = a.getPool();
  try {
    assert.equal(b.getPool(), pool, "both copies hand out the same pool");
    assert.equal(pool.options.max, 2);

    // Six slow queries at once, through both copies: the process never holds
    // more than DB_POOL_MAX connections. With a pool per copy it held four.
    let peak = 0;
    const sample = setInterval(() => (peak = Math.max(peak, pool.totalCount)), 2);
    try {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).getPool().query("SELECT pg_sleep(0.05)")),
      );
    } finally {
      clearInterval(sample);
    }
    peak = Math.max(peak, pool.totalCount);
    assert.ok(peak <= 2, `the process held ${peak} connections with DB_POOL_MAX=2`);
    assert.ok(peak >= 1);
  } finally {
    await pool.end();
  }
});
