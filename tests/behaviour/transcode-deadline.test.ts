// A transcode whose ffprobe or ffmpeg never exits.
//
// runJob heartbeats the lease for as long as the handler is pending, so a
// child process that hangs -- a malformed upload that sends a demuxer round an
// endless loop, a trickle of reads that never ends -- used to hold the job
// 'running' with a fresh lease for good. The reaper never took it back, and
// with the deployed WORKER_CONCURRENCY=1 no other video was transcoded until an
// operator restarted the worker; that restart then released the job uncounted,
// so it was claimed again after the backlog and hung again.
//
// Each test starts the REAL worker (see _worker.ts) with stand-in tools first
// on its PATH (_stand-in.ts) and TRANSCODE_DEADLINE_MS set, so a deadline that
// is minutes in production is seconds here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase } from "./_harness.js";
import { withWorkerWorld, waitFor, seedJob, seedSubmission, sourceKeyFor, type WorkerWorld } from "./_worker.js";
import { startFakeStorage } from "./_storage.js";
import { alive, FFMPEG_WRITES_OUTPUT, HANGS, probeModule, standIns, standInSkip } from "./_stand-in.js";

const skip = needsDatabase() || standInSkip();

type Job = { status: string; attempts: number };
const job = async (w: WorkerWorld, id: string) =>
  (await w.q<Job>(`SELECT status, attempts FROM ${w.schema}.jobs WHERE id = $1`, [id]))[0]!;
const video = async (w: WorkerWorld, id: string) =>
  (await w.q<{ status: string; processing_log: string | null }>(
    `SELECT status, processing_log FROM ${w.schema}.video_submissions WHERE id = $1`,
    [id],
  ))[0]!;
const ledger = async (w: WorkerWorld, id: string) =>
  w.q<{ status: string; error: string | null }>(
    `SELECT status, error FROM ${w.schema}.transcode_jobs WHERE video_submission_id = $1 ORDER BY created_at`,
    [id],
  );

test(
  "W3-54: an ffprobe that never exits is killed at its deadline, the video fails for good, and the next one is claimed",
  { skip, timeout: 120_000 },
  async () => {
    const storage = await startFakeStorage();
    const tools = standIns({ ffprobe: HANGS, ffmpeg: FFMPEG_WRITES_OUTPUT });
    try {
      await withWorkerWorld(async (w) => {
        const hung = await seedSubmission(w, "queued");
        storage.put("videos-original", sourceKeyFor(hung), Buffer.alloc(1024, 7), "video/mp4");
        const hungJob = await seedJob(w, hung, { status: "queued", attempts: 0, maxAttempts: 3 });
        await new Promise((r) => setTimeout(r, 50)); // claimed oldest run_at first
        const next = await seedSubmission(w, "queued");
        storage.put("videos-original", sourceKeyFor(next), Buffer.alloc(1024, 7), "video/mp4");
        const nextJob = await seedJob(w, next, { status: "queued", attempts: 0, maxAttempts: 3 });

        const worker = w.spawnWorker({
          NEXT_PUBLIC_SUPABASE_URL: storage.url,
          TRANSCODE_DEADLINE_MS: "3000",
          ...tools.env,
        });
        const dead = await waitFor(async () => (await job(w, hungJob)).status === "dead", 45_000);
        assert.ok(
          dead,
          `a hung ffprobe held the only transcode slot: job ${JSON.stringify(await job(w, hungJob))}, ` +
            `video ${JSON.stringify(await video(w, hung))}, next job ${JSON.stringify(await job(w, nextJob))}\n${worker.output()}`,
        );

        // The same bytes hang the same demuxer on every attempt: no attempt
        // is spent finding that out twice.
        assert.deepEqual(await job(w, hungJob), { status: "dead", attempts: 1 });
        const rows = await ledger(w, hung);
        assert.deepEqual(rows.map((r) => r.status), ["failed"], `ledger: ${JSON.stringify(rows)}`);
        assert.match(rows[0]!.error ?? "", /ffprobe did not finish within 3 s/);
        const v = await video(w, hung);
        assert.equal(v.status, "failed");
        assert.match(v.processing_log ?? "", /could not be read as a video/);

        // And the process itself is gone, not left running behind the job.
        const [probe] = tools.calls("ffprobe");
        assert.ok(probe, "the stand-in ffprobe never ran");
        assert.ok(await waitFor(async () => !alive(probe.pid), 5_000), "the hung ffprobe was not killed");

        // The slot is free again: the video queued behind it is claimed.
        const claimed = await waitFor(async () => (await job(w, nextJob)).attempts >= 1, 30_000);
        assert.ok(claimed, `the next video was never claimed: ${JSON.stringify(await job(w, nextJob))}\n${worker.output()}`);
      });
    } finally {
      await storage.close();
      await tools.close();
    }
  },
);

test(
  "W3-54: an ffmpeg encode that never exits is killed at its deadline, and the attempt is counted and retried",
  { skip, timeout: 120_000 },
  async () => {
    const storage = await startFakeStorage();
    const tools = standIns({ ffprobe: probeModule(), ffmpeg: HANGS });
    try {
      await withWorkerWorld(async (w) => {
        const sub = await seedSubmission(w, "queued");
        storage.put("videos-original", sourceKeyFor(sub), Buffer.alloc(1024, 7), "video/mp4");
        const jobId = await seedJob(w, sub, { status: "queued", attempts: 0, maxAttempts: 3 });

        const worker = w.spawnWorker({
          NEXT_PUBLIC_SUPABASE_URL: storage.url,
          TRANSCODE_DEADLINE_MS: "3000",
          ...tools.env,
        });
        const failed = await waitFor(async () => (await ledger(w, sub)).some((r) => r.status === "failed"), 45_000);
        assert.ok(
          failed,
          `a hung ffmpeg kept the attempt running: job ${JSON.stringify(await job(w, jobId))}, ` +
            `ledger ${JSON.stringify(await ledger(w, sub))}\n${worker.output()}`,
        );
        await waitFor(async () => (await job(w, jobId)).status === "queued", 10_000);

        // A normal failure, not a shutdown: the attempt is COUNTED (a release
        // would refund it, and the job could never reach the DLQ), and the
        // queue retries it later by itself.
        assert.deepEqual(await job(w, jobId), { status: "queued", attempts: 1 });
        const rows = await ledger(w, sub);
        assert.deepEqual(rows.map((r) => r.status), ["failed"]);
        assert.match(rows[0]!.error ?? "", /ffmpeg did not finish within 3 s/);
        const v = await video(w, sub);
        assert.equal(v.status, "queued", "with retries left the video stays queued");
        assert.match(v.processing_log ?? "", /retrying/);

        const [encode] = tools.calls("ffmpeg");
        assert.ok(encode, "the stand-in ffmpeg never ran");
        assert.ok(await waitFor(async () => !alive(encode.pid), 5_000), "the hung ffmpeg was not killed");
        assert.ok(worker.alive());
      });
    } finally {
      await storage.close();
      await tools.close();
    }
  },
);

test("W3-54: the encode's deadline scales with the source, and never cuts a real encode short", async () => {
  const { encodeDeadlineMs, PROBE_DEADLINE_MS } = await import("../../apps/worker/src/encode.ts");
  const min = 60_000;
  // Three rungs at -preset veryfast on the 2-vCPU target run at about 3x
  // real time for a 1080p source (measured); the deadline allows twice that.
  assert.equal(encodeDeadlineMs(60), 30 * min, "a short clip still gets the 30-minute floor");
  assert.equal(encodeDeadlineMs(60 * 60), 6 * 60 * min, "an hour-long lesson gets six hours");
  // A probe that could not say how long the source is.
  assert.equal(encodeDeadlineMs(null), 4 * 60 * min);
  assert.equal(encodeDeadlineMs(0), 4 * 60 * min);
  assert.equal(PROBE_DEADLINE_MS, 2 * min);
});
