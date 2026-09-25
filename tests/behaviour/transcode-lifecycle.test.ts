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
import { needsDatabase } from "./_harness.js";
import { withWorkerWorld, waitFor, seedJob, seedSubmission, type WorkerWorld } from "./_worker.js";

const skip = needsDatabase();

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
