// The job queue, executed.
//
// Every assertion here runs real SQL against a real Postgres. The properties
// being checked are the ones that decide whether a video ever transcodes:
//
//   * two workers must not claim the same job
//   * a hard-killed worker's job must come back
//   * a legitimately slow job must NOT come back while it is still running
//   * a duplicate enqueue must be absorbed, but a deliberate retry must not be
//
// The last pair is the subtle one, and getting it wrong is what made transcode
// retries structurally impossible on the previous pipeline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  claim,
  enqueue,
  fail,
  heartbeat,
  pruneFinished,
  reapExpiredLeases,
  succeed,
  queueDepth,
} from "@gml/db/queue";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";

const skip = needsDatabase();

function makeDb() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  return { db: drizzle(pool), close: () => pool.end() };
}

/** Remove only the rows a given test created. */
async function cleanup(db: ReturnType<typeof makeDb>["db"], name: string) {
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`DELETE FROM jobs WHERE name = ${name}`);
}

test("two concurrent claims never return the same job", { skip }, async () => {
  const { db, close } = makeDb();
  const name = tag("claim-race");
  try {
    // Ten jobs, ten simultaneous claims. Without SKIP LOCKED the second claimer
    // BLOCKS on the row the first locked, and a naive read-then-update returns
    // the same row to both.
    for (let i = 0; i < 10; i += 1) {
      await enqueue(db, { queue: "transcode", name, payload: { i } });
    }

    const claimed = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claim(db, "transcode", `w${i}`)),
    );
    const mine = claimed.filter((j) => j && j.name === name);
    const ids = mine.map((j) => j!.id);

    assert.equal(
      new Set(ids).size,
      ids.length,
      "the same job was handed to more than one worker — SKIP LOCKED is not doing its job",
    );
    assert.ok(ids.length > 0, "nothing was claimed at all");
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("a claimed job is not visible to another claim", { skip }, async () => {
  const { db, close } = makeDb();
  const name = tag("exclusive");
  try {
    await enqueue(db, { queue: "transcode", name, payload: {} });
    const first = await claim(db, "transcode", "worker-a");
    assert.ok(first, "the job should have been claimable");

    // Drain anything else that happens to be queued, then confirm ours is not
    // among what remains.
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const j = await claim(db, "transcode", "worker-b");
      if (!j) break;
      seen.push(j.id);
    }
    assert.ok(
      !seen.includes(first!.id),
      "a running job was claimed a second time",
    );
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("an expired lease is requeued; a heartbeated one is not", { skip }, async () => {
  const { db, close } = makeDb();
  const { sql } = await import("drizzle-orm");
  const name = tag("lease");
  try {
    await enqueue(db, { queue: "transcode", name, payload: { which: "abandoned" } });
    await enqueue(db, { queue: "transcode", name, payload: { which: "alive" } });

    const a = await claim(db, "transcode", "dying-worker");
    const b = await claim(db, "transcode", "healthy-worker");
    assert.ok(a && b, "both jobs should have been claimable");

    // Simulate a worker killed with SIGKILL: no catch block ran, nothing marked
    // the job failed, and the lease simply stops being extended.
    await db.execute(sql`
      UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = ${a!.id}::uuid
    `);
    // The other worker is slow but alive.
    await heartbeat(db, b!.id, 900);

    const reaped = await reapExpiredLeases(db);
    assert.ok(reaped.some((r) => r.id === a!.id && !r.dead), "the abandoned job was not requeued");

    const rows = await db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM jobs WHERE name = ${name}
    `);
    const byId = new Map(
      ((rows as unknown as { rows: { id: string; status: string }[] }).rows ?? []).map((r) => [
        r.id,
        r.status,
      ]),
    );

    assert.equal(byId.get(a!.id), "queued", "the abandoned job should be runnable again");
    assert.equal(
      byId.get(b!.id),
      "running",
      "a heartbeating worker's job was reaped out from under it — a 40-minute " +
        "ffmpeg run would be transcoded repeatedly until it dead-lettered",
    );
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("F04: a lease reaped at max attempts is dead-lettered WITH completed_at, so it is pruned", { skip }, async () => {
  const { db, close } = makeDb();
  const { sql } = await import("drizzle-orm");
  const name = tag("reap-dead");
  try {
    // The state a worker SIGKILLed on the job's last attempt leaves behind. Set
    // directly rather than through claim(), which could hand this test another
    // file's job from the shared queue.
    const j = await enqueue(db, { queue: "transcode", name, payload: {}, maxAttempts: 1 });
    await db.execute(sql`
      UPDATE jobs SET status = 'running', attempts = 1, locked_by = 'killed',
                      lease_expires_at = now() - interval '1 minute'
       WHERE id = ${j.id}::uuid
    `);

    await reapExpiredLeases(db);
    const row = async () =>
      ((await db.execute<{ status: string; completed: boolean }>(sql`
        SELECT status, completed_at IS NOT NULL AS completed FROM jobs WHERE id = ${j.id}::uuid
      `)) as unknown as { rows: { status: string; completed: boolean }[] }).rows[0];
    assert.equal((await row())?.status, "dead");
    // pruneFinished keys dead jobs on completed_at. Without it the row -- and
    // the 'N failed' topbar chip that counts it -- stayed forever.
    assert.equal((await row())?.completed, true, "a reaper dead-letter must set completed_at like fail() does");

    await db.execute(sql`UPDATE jobs SET completed_at = now() - interval '31 days' WHERE id = ${j.id}::uuid`);
    await pruneFinished(db, { deadOlderThanDays: 30 });
    assert.equal(await row(), undefined, "a month-old dead job was not pruned");
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("a duplicate enqueue is absorbed while the job is live", { skip }, async () => {
  const { db, close } = makeDb();
  const name = tag("dedupe");
  const key = tag("submission");
  try {
    const first = await enqueue(db, { queue: "transcode", name, payload: {}, dedupeKey: key });
    const second = await enqueue(db, { queue: "transcode", name, payload: {}, dedupeKey: key });

    assert.equal(second.deduped, true, "the second enqueue should have been absorbed");
    assert.equal(
      second.id,
      first.id,
      "a deduped enqueue must hand back the LIVE job's id, so the caller has " +
        "something to report and cannot tell the difference",
    );
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("a deliberate retry AFTER completion is allowed", { skip }, async () => {
  const { db, close } = makeDb();
  const name = tag("retry-after");
  const key = tag("submission");
  try {
    const first = await enqueue(db, { queue: "transcode", name, payload: {}, dedupeKey: key });
    const job = await claim(db, "transcode", "w");
    assert.ok(job);
    await succeed(db, job!.id);

    // THE PROPERTY THAT MATTERS. jobs_dedupe_live_uq is partial, over
    // queued/running only. A plain unique index on (queue, dedupe_key) would
    // make the operator Retry button impossible forever after the first run --
    // the same class of mistake as the plain INSERT against
    // files_bucket_objectkey_uq that made transcode attempts 2 and 3 fail by
    // construction.
    const again = await enqueue(db, { queue: "transcode", name, payload: {}, dedupeKey: key });
    assert.equal(again.deduped, false, "a retry after completion must create a NEW job");
    assert.notEqual(again.id, first.id);
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("failures back off, then dead-letter rather than looping", { skip }, async () => {
  const { db, close } = makeDb();
  const { sql } = await import("drizzle-orm");
  const name = tag("backoff");
  try {
    await enqueue(db, { queue: "transcode", name, payload: {}, maxAttempts: 2 });

    const a = await claim(db, "transcode", "w");
    assert.ok(a);
    const r1 = await fail(db, a!.id, "boom", a!.attempts, a!.maxAttempts);
    assert.equal(r1.willRetry, true, "attempt 1 of 2 should be retried");

    // Retried jobs are scheduled into the FUTURE, so an immediately-failing job
    // cannot spin the worker.
    const after = await db.execute<{ status: string; future: boolean }>(sql`
      SELECT status, run_at > now() AS future FROM jobs WHERE id = ${a!.id}::uuid
    `);
    const row = ((after as unknown as { rows: { status: string; future: boolean }[] }).rows ?? [])[0];
    assert.equal(row?.status, "queued");
    assert.equal(row?.future, true, "a retry must be delayed, or a failing job spins the worker");

    // Make it runnable again and exhaust it.
    await db.execute(sql`UPDATE jobs SET run_at = now() WHERE id = ${a!.id}::uuid`);
    const b = await claim(db, "transcode", "w");
    assert.ok(b);
    const r2 = await fail(db, b!.id, "boom again", b!.attempts, b!.maxAttempts);
    assert.equal(r2.willRetry, false);

    const dead = await db.execute<{ status: string }>(sql`
      SELECT status FROM jobs WHERE id = ${a!.id}::uuid
    `);
    assert.equal(
      ((dead as unknown as { rows: { status: string }[] }).rows ?? [])[0]?.status,
      "dead",
      "an exhausted job must be 'dead', distinct from 'failed' — the difference " +
        "is what tells an operator 'will retry' from 'needs a human'",
    );
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("F09: a failed attempt is retried minutes later, so a short outage cannot spend the whole budget", { skip }, async () => {
  const { db, close } = makeDb();
  const { sql } = await import("drizzle-orm");
  const name = tag("backoff-span");
  try {
    const j = await enqueue(db, { queue: "transcode", name, payload: {}, maxAttempts: 3 });
    const delay = async () =>
      Number(((await db.execute<{ s: number }>(sql`
        SELECT extract(epoch FROM run_at - now())::float8 AS s FROM jobs WHERE id = ${j.id}::uuid
      `)) as unknown as { rows: { s: number }[] }).rows[0]!.s);

    // Retries at +5 s and +10 s put all three attempts inside ~15 s: a one-
    // minute Storage or pooler blip dead-lettered every transcode that started
    // during it, and an operator had to retry each by hand.
    await fail(db, j.id, "transient", 1, 3);
    assert.ok((await delay()) >= 55, `attempt 2 was scheduled ${(await delay()).toFixed(0)} s out`);
    await fail(db, j.id, "transient again", 2, 3);
    assert.ok((await delay()) >= 9 * 60, `attempt 3 was scheduled ${(await delay()).toFixed(0)} s out`);
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("F15: a long error keeps its END in last_error, where the verdict is", { skip }, async () => {
  const { db, close } = makeDb();
  const { sql } = await import("drizzle-orm");
  const name = tag("tail");
  try {
    const j = await enqueue(db, { queue: "transcode", name, payload: {}, maxAttempts: 3 });
    // What ffmpeg's stderr looks like on a long failure: pages of per-packet
    // noise, and the decisive line last.
    const error = `Error: ffmpeg exited 69\n${"[h264 @ 0x55] Invalid NAL unit size\n".repeat(300)}Conversion failed! ${name}`;
    await fail(db, j.id, error, 1, 3);
    const [row] = ((await db.execute<{ last_error: string }>(sql`
      SELECT last_error FROM jobs WHERE id = ${j.id}::uuid
    `)) as unknown as { rows: { last_error: string }[] }).rows;
    assert.ok(row!.last_error.length <= 4000, "last_error is bounded");
    assert.ok(row!.last_error.endsWith(`Conversion failed! ${name}`), "the verdict at the end of the error was cut off");
    assert.ok(row!.last_error.startsWith("Error: ffmpeg exited 69"), "the first line says what failed");
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("F15: a failure the handler knows is permanent is dead-lettered at once, not retried", { skip }, async () => {
  const { db, close } = makeDb();
  const { sql } = await import("drizzle-orm");
  const name = tag("permanent");
  try {
    const j = await enqueue(db, { queue: "transcode", name, payload: {}, maxAttempts: 3 });
    const failWith = fail as unknown as (...a: unknown[]) => Promise<{ willRetry: boolean }>;
    const r = await failWith(db, j.id, "This file is not a playable video", 1, 3, { retryable: false });
    assert.equal(r.willRetry, false, "a corrupt source was scheduled for two more identical attempts");
    const [row] = ((await db.execute<{ status: string; done: boolean }>(sql`
      SELECT status, completed_at IS NOT NULL AS done FROM jobs WHERE id = ${j.id}::uuid
    `)) as unknown as { rows: { status: string; done: boolean }[] }).rows;
    assert.deepEqual(row, { status: "dead", done: true });
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("queueDepth counts what the admin view renders", { skip }, async () => {
  const { db, close } = makeDb();
  const name = tag("depth");
  try {
    const before = await queueDepth(db, "transcode");
    await enqueue(db, { queue: "transcode", name, payload: {} });
    const after = await queueDepth(db, "transcode");
    assert.equal(
      after.queued,
      before.queued + 1,
      "an enqueued job must show up in the depth the topbar chip reads",
    );
  } finally {
    await cleanup(db, name);
    await close();
  }
});

test("pruneFinished does not delete live work", { skip }, async () => {
  const { db, close } = makeDb();
  const { sql } = await import("drizzle-orm");
  const name = tag("prune");
  try {
    await enqueue(db, { queue: "transcode", name, payload: { keep: true } });
    const done = await enqueue(db, { queue: "transcode", name, payload: { drop: true } });
    const j = await claim(db, "transcode", "w");
    if (j) await succeed(db, j.id);
    // Age the completed row past the retention window.
    await db.execute(sql`
      UPDATE jobs SET completed_at = now() - interval '48 hours'
       WHERE name = ${name} AND status = 'succeeded'
    `);

    await pruneFinished(db, { succeededOlderThanHours: 24 });

    const left = await db.execute<{ status: string }>(sql`
      SELECT status FROM jobs WHERE name = ${name}
    `);
    const statuses = ((left as unknown as { rows: { status: string }[] }).rows ?? []).map(
      (r) => r.status,
    );
    assert.ok(
      statuses.every((s) => s !== "succeeded"),
      "aged successes should be pruned",
    );
    assert.ok(statuses.length >= 1, "pruning must not touch queued work");
    void done;
  } finally {
    await cleanup(db, name);
    await close();
  }
});
