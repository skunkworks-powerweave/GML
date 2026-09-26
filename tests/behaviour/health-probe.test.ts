// /api/health's database probes must fail exactly when the application's own
// database connection fails.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// pingDb and pingMigrations each built a private pg.Pool from DATABASE_URL.
// The application's pool (packages/db/src/client.ts) does not use DATABASE_URL
// alone: with no `sslmode` in it, it FORCES TLS, because the Supabase pooler is
// reached over the internet. The probes' pools did not, so the two disagreed
// about the one thing a health check exists to answer. Seen for real: against
// a Postgres without TLS, every page returned 500 ("The server does not support
// SSL connections") while /api/health reported `db: true` -- and the deploy
// script's readiness wait and Docker's HEALTHCHECK both believed it.
//
// The test reproduces exactly that: a DATABASE_URL without `sslmode`, pointed
// at the suite's Postgres, which (like the stock postgres image CI runs, and
// the local Supabase stack) does not offer TLS. The app cannot connect there;
// the probes must say so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { needsDatabase, DATABASE_URL } from "./_harness.js";

const withoutSslmode = (url: string) => {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return u.toString();
};

/** Whether the server accepts TLS at all; if it does, this scenario cannot be staged here. */
async function serverOffersTls(url: string): Promise<boolean> {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
  try {
    await c.connect();
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

test("the database probes fail when the application's own connection fails", { skip: needsDatabase() }, async (t) => {
  const url = withoutSslmode(DATABASE_URL!);
  if (await serverOffersTls(url)) {
    t.skip("this Postgres accepts TLS, so the app's forced-TLS connection would succeed; nothing to disagree about");
    return;
  }
  // Must be set before @gml/db is first imported: its pool reads it once.
  process.env.DATABASE_URL = url;
  const { db } = await import("../../packages/db/src/client.ts");
  const { sql } = await import("drizzle-orm");
  await assert.rejects(db.execute(sql`SELECT 1`), /SSL/i, "premise: the application itself cannot connect with this URL");

  const { pingDb, pingMigrations } = await import("../../apps/web/src/lib/health.ts");
  const db1 = await pingDb();
  assert.equal(db1.ok, false, "health must not report the database up while every page is failing to reach it");
  assert.match(db1.detail ?? "", /SSL/i, "and it must say why, in the operator's terms");
  const mig = await pingMigrations();
  assert.equal(mig.ok, false, "the migrations probe must use the same connection too");
});

// The passing case is tests/behaviour/health-probe-ok.test.ts: the pool reads
// DATABASE_URL once per process, so it cannot share this file.
