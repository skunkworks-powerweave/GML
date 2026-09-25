// How many Postgres connections one process may hold.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The runbook requires Supabase's SESSION pooler (port 5432). In session mode
// every client connection holds one pooler slot for as long as it is open, and
// the slots ARE the pool size -- 15 by default on the smaller computes -- so the
// sixteenth connect fails outright ("max clients reached"). client.ts gave
// every process a hard-coded `max: 10`, and app and worker each run one: a
// burst of dashboard loads in the app (whose queries run in parallel) plus the
// worker's own connections could exhaust the pooler, and then pages error,
// /api/health reports 503 and the worker's claims fail -- with nothing an
// operator could tune and nothing documenting the budget.
//
// ── WHAT THIS CHECKS ─────────────────────────────────────────────────────────
//
// poolConfig() -- the one config every connection is built from -- honours
// DB_POOL_MAX. tests/governance/test_db_pool_budget.test.mjs checks that
// docker-compose.yml sizes each container so the whole stack fits.

import { test } from "node:test";
import assert from "node:assert/strict";

// client.ts builds its shared pool at import time. This URL is never dialled:
// nothing here runs a query.
process.env.DATABASE_URL ??= "postgres://u:p@127.0.0.1:9/never?sslmode=disable";

async function maxWith(value: string | undefined): Promise<number | undefined> {
  const { poolConfig } = await import("../../packages/db/src/client.ts");
  const before = process.env.DB_POOL_MAX;
  if (value === undefined) delete process.env.DB_POOL_MAX;
  else process.env.DB_POOL_MAX = value;
  try {
    return poolConfig().max;
  } finally {
    if (before === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = before;
  }
}

test("poolConfig() takes its ceiling from DB_POOL_MAX", async () => {
  assert.equal(await maxWith("4"), 4, "DB_POOL_MAX=4 must cap the pool at 4 connections");
  assert.equal(await maxWith(" 8 "), 8);
});

test("without a usable DB_POOL_MAX the ceiling is the old default of 10, and a bad value is reported", async () => {
  assert.equal(await maxWith(undefined), 10);
  assert.equal(await maxWith(""), 10, "empty -- what compose forwards for an unset key -- means unset");
  const warn = console.warn;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  try {
    for (const bad of ["0", "-3", "2.5", "lots", "1000"]) {
      assert.equal(await maxWith(bad), 10, `DB_POOL_MAX=${JSON.stringify(bad)} must fall back to 10`);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(
    said.filter((l) => /DB_POOL_MAX/.test(l)).length,
    5,
    `each unusable value must be reported, not silently ignored:\n${said.join("\n")}`,
  );
});
