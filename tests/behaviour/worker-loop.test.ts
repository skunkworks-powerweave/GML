// The worker PROCESS, executed: its consumer loop and its database pool, under
// the database failures a single box in Leh will actually see.
//
// Every test here spawns the real entrypoint (see _worker.ts) and judges it the
// way an operator would: is the process still alive, and does it still claim
// work. A worker that is "up" but never claims again is the failure that no
// healthcheck here could see -- the container stays healthy, restart policy
// never fires, and every video after that moment waits forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase } from "./_harness.js";
import { withWorkerWorld, waitFor } from "./_worker.js";

const skip = needsDatabase();

type JobRow = { id: string; status: string; attempts: number };

test(
  "F01: a database error while recording a job's outcome does not end the consumer loop",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      // Every write that would move the job named 'fault' out of 'running' is
      // refused, the way Supabase refuses writes in read-only mode (SQLSTATE
      // 25006) while the connection itself stays up. Its handler throws (the
      // name is unknown), so the worker's next step is fail() -- which is the
      // write that is refused.
      await w.q(`
        CREATE FUNCTION ${w.schema}.refuse_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'cannot execute UPDATE in a read-only transaction' USING ERRCODE = '25006';
        END $$`);
      await w.q(`
        CREATE TRIGGER refuse_outcome BEFORE UPDATE ON ${w.schema}.jobs FOR EACH ROW
          WHEN (OLD.name = 'fault' AND OLD.status = 'running' AND NEW.status <> 'running')
          EXECUTE FUNCTION ${w.schema}.refuse_outcome()`);
      // Oldest first: claim() orders by run_at, so 'fault' is taken first and
      // 'probe' only once the loop comes round again.
      const [fault] = await w.q<{ id: string }>(
        `INSERT INTO ${w.schema}.jobs (queue, name, payload, run_at) VALUES ('transcode', 'fault', '{}', now() - interval '1 minute') RETURNING id`,
      );
      const [probe] = await w.q<{ id: string }>(
        `INSERT INTO ${w.schema}.jobs (queue, name, payload, max_attempts) VALUES ('transcode', 'probe', '{}', 1) RETURNING id`,
      );

      const worker = w.spawnWorker();
      const job = async (id: string) =>
        (await w.q<JobRow>(`SELECT id, status, attempts FROM ${w.schema}.jobs WHERE id = $1`, [id]))[0]!;

      const claimedFault = await waitFor(async () => (await job(fault!.id)).attempts >= 1, 30_000);
      assert.ok(claimedFault, `the worker never claimed the first job:\n${worker.output()}`);

      // THE PROPERTY. With WORKER_CONCURRENCY=1 there is exactly one transcode
      // consumer; if the refused write ends it, 'probe' is never claimed while
      // the process -- and its healthcheck -- carry on as if nothing happened.
      const claimedProbe = await waitFor(async () => (await job(probe!.id)).attempts >= 1, 30_000);
      assert.ok(
        claimedProbe,
        "no job was claimed after the outcome write failed -- the only transcode consumer is " +
          `gone while the process stays up (alive=${worker.alive()}):\n${worker.output()}`,
      );
      assert.ok(worker.alive(), `the worker process exited:\n${worker.output()}`);

      // The job whose outcome could not be written is left to the lease reaper,
      // which is the recovery path the design already has -- it is not dropped
      // and it is not marked anything it did not reach.
      assert.equal((await job(fault!.id)).status, "running");
    });
  },
);

test(
  "F148: a server-side reset of an idle pooled connection does not kill the worker",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const worker = w.spawnWorker();
      // The consumer loops poll every 2 s, so between polls their pooled
      // clients sit idle -- which is where pg-pool re-emits a connection's
      // error on the Pool itself.
      const idle = await waitFor(async () => {
        const rows = await w.q<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND state = 'idle'`,
          [w.schema],
        );
        return rows.length > 0 ? rows : null;
      }, 30_000);
      assert.ok(idle, `the worker never opened a pooled connection:\n${worker.output()}`);

      // What a pooler restart, a Supabase maintenance failover or a TCP reset on
      // the EC2-to-Supabase path does to a connection nobody is using.
      await w.q(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`, [w.schema]);
      await new Promise((r) => setTimeout(r, 3000));
      assert.ok(
        worker.alive(),
        `terminating an idle connection killed the worker (exit ${await Promise.race([worker.exited, "?"])}):\n${worker.output()}`,
      );

      // The pool discards the dead client and dials a fresh one on next use.
      const [probe] = await w.q<{ id: string }>(
        `INSERT INTO ${w.schema}.jobs (queue, name, payload, max_attempts) VALUES ('transcode', 'probe', '{}', 1) RETURNING id`,
      );
      const claimed = await waitFor(async () => {
        const [r] = await w.q<JobRow>(`SELECT id, status, attempts FROM ${w.schema}.jobs WHERE id = $1`, [probe!.id]);
        return r!.attempts >= 1;
      }, 30_000);
      assert.ok(claimed, `the worker survived but stopped claiming:\n${worker.output()}`);
    });
  },
);
