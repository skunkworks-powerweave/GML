// A transcode's DOMAIN rows -- the transcode_jobs ledger row per attempt and
// video_submissions.status -- across everything that can end an attempt other
// than its own catch block: a SIGKILL or OOM (found later by the lease reaper),
// and a throw before the handler's try.
//
// These rows are what people see. The ledger is what /admin/transcode-jobs
// lists and gates Retry/Drop on; the status is what the teacher's video page
// renders. The transport row in `jobs` recovering on its own is not enough if
// these two keep saying 'running' and 'transcoding' forever.
//
// Each test seeds the exact state a failure leaves behind into an isolated
// schema and starts the REAL worker on it (see _worker.ts), whose housekeeping
// tick runs immediately at startup. Storage is a closed port, so any attempt
// that gets as far as downloading the source fails there, quickly.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { withWorkerWorld, waitFor, seedJob, seedSubmission, type WorkerWorld } from "./_worker.js";

const skip = needsDatabase();

// The DLQ's own rule for which verbs a row gets (the page and the actions share it).
const dlqState = () => import("../../apps/web/src/app/(authenticated)/admin/transcode-jobs/state.ts");

type Ledger = { id: string; status: string; ended: boolean; error: string | null };
type Video = { status: string; processing_log: string | null };
type Job = { status: string; attempts: number; completed: boolean };

async function seedLedger(w: WorkerWorld, submissionId: string): Promise<string> {
  const [r] = await w.q<{ id: string }>(
    `INSERT INTO ${w.schema}.transcode_jobs (video_submission_id, profile, status, started_at)
       VALUES ($1, '480p', 'running', now() - interval '20 minutes') RETURNING id`,
    [submissionId],
  );
  return r!.id;
}

const ledger = async (w: WorkerWorld, submissionId: string) =>
  w.q<Ledger>(
    `SELECT id, status, ended_at IS NOT NULL AS ended, error FROM ${w.schema}.transcode_jobs
      WHERE video_submission_id = $1 ORDER BY created_at`,
    [submissionId],
  );
const video = async (w: WorkerWorld, id: string) =>
  (await w.q<Video>(`SELECT status, processing_log FROM ${w.schema}.video_submissions WHERE id = $1`, [id]))[0]!;
const job = async (w: WorkerWorld, id: string) =>
  (await w.q<Job>(
    `SELECT status, attempts, completed_at IS NOT NULL AS completed FROM ${w.schema}.jobs WHERE id = $1`,
    [id],
  ))[0]!;

const state = async (w: WorkerWorld, sub: string, jobId: string) =>
  JSON.stringify({ job: await job(w, jobId), video: await video(w, sub), ledger: await ledger(w, sub) });

// ── F04 ──────────────────────────────────────────────────────────────────────

test(
  "F04: a transcode hard-stopped on its last attempt -- the reaper fails its ledger row and its video",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const sub = await seedSubmission(w, "transcoding");
      const orphan = await seedLedger(w, sub);
      const jobId = await seedJob(w, sub, { status: "running", attempts: 3, maxAttempts: 3 });

      const worker = w.spawnWorker();
      const settled = await waitFor(async () => (await job(w, jobId)).status === "dead" && (await video(w, sub)).status !== "transcoding", 30_000);

      assert.ok(settled, `after the reaper ran: ${await state(w, sub, jobId)}\n${worker.output()}`);
      const [row] = (await ledger(w, sub)).filter((r) => r.id === orphan);
      assert.equal(row?.status, "failed", "the dead attempt's ledger row must not stay 'running' forever");
      assert.ok(row?.ended, "the ledger row needs an ended_at");
      assert.match(row?.error ?? "", /stopped responding/i);
      // The teacher's page renders 'transcoding' as "Transcoding in progress"
      // -- which, for a job that is dead, it would have said forever.
      assert.equal((await video(w, sub)).status, "failed");
      assert.equal((await job(w, jobId)).completed, true, "a dead-lettered job must carry completed_at");
      assert.match(worker.output(), /dead-lettered/, "the log must say dead-lettered, not 'requeued'");
    });
  },
);

test(
  "F04: a transcode hard-stopped with attempts left -- its ledger row is closed, not left 'running' beside the retry",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const sub = await seedSubmission(w, "transcoding");
      const orphan = await seedLedger(w, sub);
      const jobId = await seedJob(w, sub, { status: "running", attempts: 1, maxAttempts: 3 });

      const worker = w.spawnWorker();
      const retried = await waitFor(async () => (await job(w, jobId)).attempts >= 2, 30_000);
      assert.ok(retried, `the reaped job was never retried: ${await state(w, sub, jobId)}\n${worker.output()}`);
      const closed = (await ledger(w, sub)).find((r) => r.id === orphan);
      assert.notEqual(
        closed?.status,
        "running",
        `the killed attempt's ledger row stayed 'running' while the job was retried: ${await state(w, sub, jobId)}`,
      );
      assert.equal(closed?.status, "failed");
    });
  },
);

test(
  "F04: one reaped job whose repair throws does not hold back the rest of the reaper's batch",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      // A killed transcode, exactly as the other tests seed it...
      const sub = await seedSubmission(w, "transcoding");
      const orphan = await seedLedger(w, sub);
      const jobId = await seedJob(w, sub, { status: "running", attempts: 3, maxAttempts: 3 });
      // ...and, expired in the same tick, one whose repair cannot succeed: a
      // payload id that is not a uuid fails the ledger query with 22P02. The
      // repair used to run in ONE transaction for the whole batch, so this
      // rolled back every reaped job with it, on every housekeeping tick --
      // expired leases on every queue stayed 'running' for good.
      const [bad] = await w.q<{ id: string }>(
        `INSERT INTO ${w.schema}.jobs (queue, name, payload, status, attempts, max_attempts, locked_by, lease_expires_at)
           VALUES ('transcode', 'transcode', '{"videoSubmissionId":"not-a-uuid"}', 'running', 3, 3,
                   'a-worker-that-was-killed', now() - interval '1 minute')
         RETURNING id`,
      );

      const worker = w.spawnWorker();
      const settled = await waitFor(async () => (await job(w, jobId)).status === "dead", 30_000);
      assert.ok(settled, `the good job was never reaped: ${await state(w, sub, jobId)}\n${worker.output()}`);
      assert.equal((await job(w, bad!.id)).status, "dead", "the job whose repair failed must still be reaped");
      assert.equal((await ledger(w, sub)).find((r) => r.id === orphan)?.status, "failed");
      assert.equal((await video(w, sub)).status, "failed");
      assert.match(worker.output(), /could not repair/i, "a repair that failed must be logged, with its job");
      assert.match(worker.output(), new RegExp(bad!.id));
    });
  },
);

test(
  "F04: a throw before the handler's try block still marks the attempt and the video failed",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      // The 'transcoding' write is refused -- a transient DB error in the
      // preamble, which used to run outside the try (as did mkdtemp, which a
      // full scratch disk fails the same way).
      await w.q(`
        CREATE FUNCTION ${w.schema}.refuse_transcoding() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'could not extend file: No space left on device' USING ERRCODE = '53100'; END $$`);
      await w.q(`
        CREATE TRIGGER refuse_transcoding BEFORE UPDATE ON ${w.schema}.video_submissions FOR EACH ROW
          WHEN (NEW.status = 'transcoding') EXECUTE FUNCTION ${w.schema}.refuse_transcoding()`);
      const sub = await seedSubmission(w, "queued");
      const jobId = await seedJob(w, sub, { status: "queued", attempts: 0, maxAttempts: 1 });

      const worker = w.spawnWorker();
      const dead = await waitFor(async () => (await job(w, jobId)).status === "dead", 30_000);
      assert.ok(dead, `the job never ran: ${await state(w, sub, jobId)}\n${worker.output()}`);
      // Give the handler's failure writes (if any) a moment to land.
      await waitFor(async () => (await ledger(w, sub)).every((r) => r.status !== "running"), 5_000);

      const rows = await ledger(w, sub);
      assert.ok(rows.length > 0, "no ledger row at all -- the DLQ would have nothing to show");
      assert.deepEqual(rows.map((r) => r.status), ["failed"], `ledger: ${JSON.stringify(rows)}`);
      assert.match(rows[0]!.error ?? "", /No space left on device/);
      assert.equal((await video(w, sub)).status, "failed", "a dead job's video must not say 'queued' forever");
    });
  },
);

test(
  "F04: a transcode that cannot even start (Storage not configured) is recorded, not left 'queued'",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const sub = await seedSubmission(w, "queued");
      const jobId = await seedJob(w, sub, { status: "queued", attempts: 0, maxAttempts: 1 });

      const worker = w.spawnWorker({ NEXT_PUBLIC_SUPABASE_URL: "" });
      const dead = await waitFor(async () => (await job(w, jobId)).status === "dead", 30_000);
      assert.ok(dead, `the job never ran: ${await state(w, sub, jobId)}\n${worker.output()}`);
      await waitFor(async () => (await video(w, sub)).status === "failed", 5_000);

      assert.equal((await video(w, sub)).status, "failed", `state: ${await state(w, sub, jobId)}`);
      const rows = await ledger(w, sub);
      assert.equal(rows.length, 1, "the failure must leave a ledger row the DLQ can show and retry");
      assert.equal(rows[0]!.status, "failed");
      assert.match(rows[0]!.error ?? "", /must be set/);
    });
  },
);

test(
  "F04: a transcode whose ledger row cannot be written still fails its video when the job dies",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      // The very first write of the attempt is refused.
      await w.q(`
        CREATE FUNCTION ${w.schema}.refuse_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'cannot execute INSERT in a read-only transaction' USING ERRCODE = '25006'; END $$`);
      await w.q(`
        CREATE TRIGGER refuse_ledger BEFORE INSERT ON ${w.schema}.transcode_jobs FOR EACH ROW
          EXECUTE FUNCTION ${w.schema}.refuse_ledger()`);
      const sub = await seedSubmission(w, "queued");
      const jobId = await seedJob(w, sub, { status: "queued", attempts: 0, maxAttempts: 1 });

      const worker = w.spawnWorker();
      const dead = await waitFor(async () => (await job(w, jobId)).status === "dead", 30_000);
      assert.ok(dead, `the job never ran: ${await state(w, sub, jobId)}\n${worker.output()}`);
      await waitFor(async () => (await video(w, sub)).status === "failed", 5_000);
      const v = await video(w, sub);
      assert.equal(v.status, "failed", `a dead job's video said '${v.status}' -- "Transcoding in progress", forever`);
      assert.match(v.processing_log ?? "", /read-only/);
    });
  },
);

test(
  "F04: rows stranded before the reaper repaired them are failed on the next tick, and the DLQ can act on them",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      // What the OLD reaper left behind, which nothing touches again: a killed
      // attempt's ledger row 'running' and its video 'transcoding', with the
      // job long since dead-lettered...
      const deadJob = await seedSubmission(w, "transcoding");
      const deadJobRow = await seedLedger(w, deadJob);
      const deadJobId = await seedJob(w, deadJob, { status: "queued", attempts: 3, maxAttempts: 3 });
      await w.q(`UPDATE ${w.schema}.jobs SET status = 'dead', completed_at = now() - interval '2 days' WHERE id = $1`, [deadJobId]);
      // ...or pruned away entirely,
      const noJob = await seedSubmission(w, "transcoding");
      const noJobRow = await seedLedger(w, noJob);
      // ...or with no ledger row at all (the old code wrote 'transcoding' before
      // its ledger row, outside the try) -- nothing for the DLQ to list.
      const noLedger = await seedSubmission(w, "transcoding");
      // The control: an attempt another worker is running right now, lease live.
      const live = await seedSubmission(w, "transcoding");
      const liveRow = await seedLedger(w, live);
      const liveJob = await seedJob(w, live, { status: "running", attempts: 1, maxAttempts: 3 });
      await w.q(`UPDATE ${w.schema}.jobs SET lease_expires_at = now() + interval '10 minutes' WHERE id = $1`, [liveJob]);

      const worker = w.spawnWorker();
      const settled = await waitFor(async () => {
        for (const id of [deadJob, noJob, noLedger]) if ((await video(w, id)).status !== "failed") return false;
        return true;
      }, 30_000);
      assert.ok(
        settled,
        `stranded videos still claim to be transcoding: ${JSON.stringify(
          await Promise.all([deadJob, noJob, noLedger].map(async (id) => ({ v: await video(w, id), l: await ledger(w, id) }))),
        )}
${worker.output()}`,
      );

      const { verbsFor } = await dlqState();
      for (const [id, row] of [[deadJob, deadJobRow], [noJob, noJobRow], [noLedger, undefined]] as const) {
        const rows = await ledger(w, id);
        const latest = rows[rows.length - 1]!;
        if (row) assert.equal(latest.id, row, "the stranded attempt's own row is closed, not replaced");
        assert.equal(latest.status, "failed", `ledger: ${JSON.stringify(rows)}`);
        assert.ok(latest.ended, "a closed attempt needs an ended_at");
        assert.match(latest.error ?? "", /no worker/i);
        assert.match((await video(w, id)).processing_log ?? "", /no worker/i);
        // What /admin/transcode-jobs offers for that row now. It offered
        // nothing: both verbs need a latest attempt that is 'failed'.
        const verbs = verbsFor(
          { jobId: latest.id, status: latest.status },
          { status: (await video(w, id)).status, latestAttemptId: latest.id, liveJob: null },
        );
        assert.deepEqual(verbs, { retry: true, drop: true });
      }

      // Nothing live was touched.
      assert.deepEqual((await ledger(w, live)).map((r) => [r.id, r.status]), [[liveRow, "running"]]);
      assert.equal((await video(w, live)).status, "transcoding", "an attempt another worker is running was failed");
      assert.equal((await job(w, liveJob)).status, "running");
      assert.match(worker.output(), /stranded/i, "a repair of stranded rows must be logged");
    });
  },
);

// W3-61. Every producer writes 'queued' in the same transaction as its job, so
// a 'queued' video with no live job has nothing coming. Two ways one arose: a
// WhatsApp Resend whose enqueue failed after its status write had committed,
// and the old worker's Storage-unset path, which threw before its ledger row
// and let the job dead-letter. The sweep above skipped 'queued' entirely, so
// the teacher's page said "in progress" for good, and the DLQ -- which needs a
// failed attempt to offer Retry -- had nothing to list.
test(
  "W3-61: a video left 'queued' with no live job is failed on the next tick, and the DLQ can Retry it",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const orphan = await seedSubmission(w, "queued");
      const deadNoLedger = await seedSubmission(w, "queued");
      const deadJobId = await seedJob(w, deadNoLedger, { status: "queued", attempts: 3, maxAttempts: 3 });
      await w.q(`UPDATE ${w.schema}.jobs SET status = 'dead', completed_at = now() - interval '2 days' WHERE id = $1`, [deadJobId]);
      // The control: a retry waiting out its backoff, which the worker will not
      // claim yet. Its video is 'queued' and must stay so.
      const waiting = await seedSubmission(w, "queued");
      const waitingJob = await seedJob(w, waiting, { status: "queued", attempts: 1, maxAttempts: 3 });
      await w.q(`UPDATE ${w.schema}.jobs SET run_at = now() + interval '1 hour' WHERE id = $1`, [waitingJob]);

      const worker = w.spawnWorker();
      const settled = await waitFor(async () => {
        for (const id of [orphan, deadNoLedger]) if ((await video(w, id)).status !== "failed") return false;
        return true;
      }, 30_000);
      assert.ok(
        settled,
        `'queued' videos with nothing queued stayed 'queued': ${JSON.stringify(
          await Promise.all([orphan, deadNoLedger].map(async (id) => ({ v: await video(w, id), l: await ledger(w, id) }))),
        )}
${worker.output()}`,
      );

      const { verbsFor } = await dlqState();
      for (const id of [orphan, deadNoLedger]) {
        const rows = await ledger(w, id);
        assert.equal(rows.length, 1, `one failed attempt for the DLQ to list: ${JSON.stringify(rows)}`);
        assert.equal(rows[0]!.status, "failed");
        assert.match(rows[0]!.error ?? "", /no worker/i);
        const verbs = verbsFor(
          { jobId: rows[0]!.id, status: rows[0]!.status },
          { status: (await video(w, id)).status, latestAttemptId: rows[0]!.id, liveJob: null },
        );
        assert.deepEqual(verbs, { retry: true, drop: true });
      }

      assert.equal((await video(w, waiting)).status, "queued", "a video whose retry is merely waiting was failed");
      assert.deepEqual(await ledger(w, waiting), []);
      assert.equal((await job(w, waitingJob)).status, "queued");
    });
  },
);

// ── F09 ──────────────────────────────────────────────────────────────────────

test(
  "F09: an attempt that fails with retries left leaves the video 'queued' (retrying), not 'failed'",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      // Storage is a closed port: the attempt fails downloading the source,
      // which is exactly a transient Storage outage.
      const sub = await seedSubmission(w, "queued");
      const jobId = await seedJob(w, sub, { status: "queued", attempts: 0, maxAttempts: 3 });

      const worker = w.spawnWorker();
      const failedOnce = await waitFor(async () => {
        const j = await job(w, jobId);
        return j.attempts === 1 && j.status === "queued";
      }, 30_000);
      assert.ok(failedOnce, `attempt 1 never failed back to the queue: ${await state(w, sub, jobId)}\n${worker.output()}`);
      await waitFor(async () => (await ledger(w, sub)).some((r) => r.status === "failed"), 5_000);

      // The teacher's page renders 'failed' as "Transcode failed. Contact your
      // programme admin." -- an invitation to re-upload, hours on 2G, for a
      // video the queue is about to try again by itself.
      const v = await video(w, sub);
      assert.equal(v.status, "queued", `with a retry pending the video said '${v.status}'`);
      assert.match(v.processing_log ?? "", /retry/i, "the note should say a retry is coming");
    });
  },
);

test(
  "F09: the failure of the LAST attempt marks the video failed",
  { skip, timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const sub = await seedSubmission(w, "queued");
      const jobId = await seedJob(w, sub, { status: "queued", attempts: 2, maxAttempts: 3 });

      const worker = w.spawnWorker();
      const dead = await waitFor(async () => (await job(w, jobId)).status === "dead", 30_000);
      assert.ok(dead, `the last attempt never ran: ${await state(w, sub, jobId)}\n${worker.output()}`);
      await waitFor(async () => (await video(w, sub)).status === "failed", 5_000);
      assert.equal((await video(w, sub)).status, "failed");
    });
  },
);
