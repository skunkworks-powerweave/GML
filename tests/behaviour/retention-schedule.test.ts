// The worker's DAILY retention schedule, executed: the real scheduleDailyWork()
// from apps/worker/src/index.ts, given a clock, against a schema of its own
// (see _worker.ts; the worker's pool is pointed at it before the module loads).
//
// It is checked hourly, and the comments promised the date-scoped dedupe key
// made it once a day -- "a restart cannot double-run it". But the dedupe index
// covers only queued and running jobs: once the day's sweep had SUCCEEDED, the
// next tick (and every restart) inserted and ran another, about 21 a day from
// 03:00 UTC, including in the Ladakh morning window 03:00 UTC was chosen to
// stay behind.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, DATABASE_URL } from "./_harness.js";
import { withWorkerWorld } from "./_worker.js";

const skip = needsDatabase();

after(async () => {
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

test("F16: the retention sweep is scheduled once per day, not on every hourly tick after 03:00 UTC", { skip }, async () => {
  await withWorkerWorld(async (w) => {
    // The module's `db` binds to DATABASE_URL when it is first imported.
    process.env.DATABASE_URL = w.url;
    const worker = (await import("../../apps/worker/src/index.ts")) as unknown as {
      scheduleDailyWork?: (now: Date) => Promise<void>;
    };
    assert.equal(typeof worker.scheduleDailyWork, "function", "scheduleDailyWork cannot be given a clock");
    const day = "2099-01-01";
    const rows = async () =>
      w.q<{ status: string }>(`SELECT status FROM ${w.schema}.jobs WHERE queue = 'retention' AND dedupe_key = $1`, [
        `retention:${day}`,
      ]);

    await worker.scheduleDailyWork!(new Date(`${day}T02:00:00Z`));
    assert.equal((await rows()).length, 0, "the sweep was scheduled before 03:00 UTC");

    await worker.scheduleDailyWork!(new Date(`${day}T03:05:00Z`));
    assert.equal((await rows()).length, 1);

    // The day's sweep runs and finishes.
    await w.q(`UPDATE ${w.schema}.jobs SET status = 'succeeded', completed_at = now() WHERE dedupe_key = $1`, [`retention:${day}`]);

    // The next hourly ticks, and a restart (which runs the same check at once).
    for (const hour of ["04", "05", "13", "23"]) {
      await worker.scheduleDailyWork!(new Date(`${day}T${hour}:05:00Z`));
    }
    assert.deepEqual(
      (await rows()).map((r) => r.status),
      ["succeeded"],
      "the day's sweep was enqueued again after it had run",
    );

    // Tomorrow is a new day.
    await worker.scheduleDailyWork!(new Date(`2099-01-02T03:05:00Z`));
    assert.equal((await w.q(`SELECT 1 FROM ${w.schema}.jobs WHERE dedupe_key = 'retention:2099-01-02'`)).length, 1);
  });
});
