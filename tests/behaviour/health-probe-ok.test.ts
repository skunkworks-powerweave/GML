// The other half of health-probe.test.ts, in its own process because the
// application's pool reads DATABASE_URL once: with a URL the application CAN
// use, the database probes report healthy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase } from "./_harness.js";

test("the database probes pass when the application's connection works", { skip: needsDatabase() }, async () => {
  const { pingDb, pingMigrations } = await import("../../apps/web/src/lib/health.ts");
  assert.deepEqual(await pingDb(), { ok: true });
  const mig = await pingMigrations();
  assert.ok(mig.applied > 0, `the migrated test database must report its migrations: ${JSON.stringify(mig)}`);
});
