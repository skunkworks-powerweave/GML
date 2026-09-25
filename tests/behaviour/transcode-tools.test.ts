// A transcode run by the REAL worker against stand-in ffprobe and ffmpeg
// (_stand-in.ts), so that a test can decide what the tools report: an
// undecodable rendition, a probe that fails, a source with no sound.
//
// transcode-e2e.test.ts runs the real ffmpeg, which is the evidence that the
// encode itself works; but a real ffmpeg on a synthetic source always writes a
// good rendition and always probes cleanly, so the worker's handling of any
// other answer was never executed. Storage is the in-process fake
// (_storage.ts); the database an isolated schema (_worker.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase } from "./_harness.js";
import { withWorkerWorld, waitFor, seedJob, seedSubmission, sourceKeyFor, type WorkerWorld } from "./_worker.js";
import { startFakeStorage, type FakeStorage } from "./_storage.js";
import { FFMPEG_WRITES_OUTPUT, probeModule, standIns, standInSkip, type StandIns } from "./_stand-in.js";

const skip = needsDatabase() || standInSkip();

type Video = { status: string; processing_log: string | null; hls_master_key: string | null };
const video = async (w: WorkerWorld, id: string) =>
  (await w.q<Video>(
    `SELECT status, processing_log, hls_master_key FROM ${w.schema}.video_submissions WHERE id = $1`,
    [id],
  ))[0]!;
const job = async (w: WorkerWorld, id: string) =>
  (await w.q<{ status: string; attempts: number }>(`SELECT status, attempts FROM ${w.schema}.jobs WHERE id = $1`, [id]))[0]!;
const ledger = async (w: WorkerWorld, id: string) =>
  w.q<{ status: string; error: string | null }>(
    `SELECT status, error FROM ${w.schema}.transcode_jobs WHERE video_submission_id = $1 ORDER BY created_at`,
    [id],
  );

/**
 * One transcode, on its LAST attempt, with these stand-ins; resolves once the
 * job has an outcome.
 */
async function transcodeWith(
  tools: Record<string, string>,
  body: (ctx: { w: WorkerWorld; sub: string; jobId: string; storage: FakeStorage; tools: StandIns; output: () => string }) => Promise<void>,
  opts: { before?: (w: WorkerWorld) => Promise<void>; env?: Record<string, string> } = {},
): Promise<void> {
  const storage = await startFakeStorage();
  const t = standIns(tools);
  try {
    await withWorkerWorld(async (w) => {
      await opts.before?.(w);
      const sub = await seedSubmission(w, "queued");
      storage.put("videos-original", sourceKeyFor(sub), Buffer.alloc(1024, 7), "video/mp4");
      const jobId = await seedJob(w, sub, { status: "queued", attempts: 0, maxAttempts: 1 });
      const worker = w.spawnWorker({ NEXT_PUBLIC_SUPABASE_URL: storage.url, ...t.env, ...opts.env });
      const done = await waitFor(async () => {
        const j = await job(w, jobId);
        return j.status === "dead" || j.status === "succeeded";
      }, 60_000);
      assert.ok(done, `the transcode never finished: ${JSON.stringify(await video(w, sub))}\n${worker.output()}`);
      await body({ w, sub, jobId, storage, tools: t, output: () => worker.output() });
    });
  } finally {
    await storage.close();
    await t.close();
  }
}

test("stand-in tools: a transcode that the tools report as good is published whole (the control)", { skip, timeout: 120_000 }, async () => {
  await transcodeWith({ ffprobe: probeModule({ width: 1280, height: 720 }), ffmpeg: FFMPEG_WRITES_OUTPUT }, async ({ w, sub, jobId, storage, output }) => {
    const v = await video(w, sub);
    assert.equal(v.status, "ready", `${v.processing_log}\n${output()}`);
    assert.equal(v.hls_master_key, `hls/${sub}/master.m3u8`);
    assert.equal((await job(w, jobId)).status, "succeeded");
    const keys = storage.keys("videos-hls", `hls/${sub}/`);
    for (const name of ["master.m3u8", "v0.m3u8", "v1.m3u8", "v2.m3u8", "v0_00000.ts", "v2_00000.ts"]) {
      assert.ok(keys.includes(`hls/${sub}/${name}`), `${name} was not uploaded (got ${keys.join(", ")})`);
    }
  });
});

// ── W3-56 ────────────────────────────────────────────────────────────────────

test(
  "W3-56: an attempt that made its video ready keeps it ready when a write after that fails",
  { skip, timeout: 120_000 },
  async () => {
    await transcodeWith(
      { ffprobe: probeModule(), ffmpeg: FFMPEG_WRITES_OUTPUT },
      async ({ w, sub, output }) => {
        const v = await video(w, sub);
        // The catch used to write 'failed' (or, with retries left, 'queued')
        // over the 'ready' this very attempt had just written.
        assert.equal(v.status, "ready", `a playable video was un-readied:\n${JSON.stringify(v)}\n${output()}`);
        assert.equal(v.hls_master_key, `hls/${sub}/master.m3u8`);
      },
      {
        // The ledger's 'succeeded' write, the one after 'ready', is refused.
        before: async (w) => {
          await w.q(`
            CREATE FUNCTION ${w.schema}.refuse_succeeded() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'terminating connection due to administrator command' USING ERRCODE = '57P01'; END $$`);
          await w.q(`
            CREATE TRIGGER refuse_succeeded BEFORE UPDATE ON ${w.schema}.transcode_jobs FOR EACH ROW
              WHEN (NEW.status = 'succeeded') EXECUTE FUNCTION ${w.schema}.refuse_succeeded()`);
        },
      },
    );
  },
);
