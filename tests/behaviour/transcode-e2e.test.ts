// A transcode, END TO END: the real worker process claims a real job, downloads
// a real source from (a fake of) Supabase Storage, runs the real ffmpeg, uploads
// what it made, and writes the rows -- and then the output is read back the way
// a viewer's player would get it.
//
// Needs a database AND ffmpeg/ffprobe on PATH; skips, saying so, without them.
// CI's behaviour job installs ffmpeg and sets GML_REQUIRE_FFMPEG=1, which
// turns a missing ffmpeg into a failure instead. Storage is the in-process
// fake in _storage.ts; the database is an isolated schema (see _worker.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsDatabase } from "./_harness.js";
import { withWorkerWorld, waitFor, seedJob, seedSubmission, sourceKeyFor, type WorkerWorld } from "./_worker.js";
import { startFakeStorage, type FakeStorage } from "./_storage.js";

const tools = ["ffmpeg", "ffprobe"].every((bin) => spawnSync(bin, ["-version"]).status === 0);
if (!tools && process.env.GML_REQUIRE_FFMPEG === "1") {
  throw new Error("GML_REQUIRE_FFMPEG=1 but ffmpeg/ffprobe are not on PATH");
}
const skip = needsDatabase() || (tools ? false : "ffmpeg/ffprobe not on PATH -- this runs a real transcode");

let storage: FakeStorage;
const dir = tools ? mkdtempSync(join(tmpdir(), "gml-e2e-")) : "";
before(async () => {
  if (!skip) storage = await startFakeStorage();
});
after(async () => {
  await storage?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A short synthetic phone clip with sound, `size` WxH. */
function makeSource(name: string, size = "640x360"): Buffer {
  const out = join(dir, name);
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", out,
  ]);
  if (r.status !== 0) throw new Error(`could not make a source: ${r.stderr}`);
  return readFileSync(out);
}

type Video = { status: string; processing_log: string | null; hls_master_key: string | null; width: number | null; height: number | null };
const video = async (w: WorkerWorld, id: string) =>
  (await w.q<Video>(
    `SELECT status, processing_log, hls_master_key, width, height FROM ${w.schema}.video_submissions WHERE id = $1`,
    [id],
  ))[0]!;

/** Seed a submission whose source is in Storage, run the worker, wait for it to settle. */
async function transcodeOnce(
  w: WorkerWorld,
  opts: { source: Buffer; processingLog?: string; attempts?: number },
): Promise<{ id: string; v: Video; output: string }> {
  const id = await seedSubmission(w, "queued", { processingLog: opts.processingLog });
  storage.put("videos-original", sourceKeyFor(id), opts.source, "video/mp4");
  await seedJob(w, id, { status: "queued", attempts: opts.attempts ?? 0, maxAttempts: 3 });
  const worker = w.spawnWorker({ NEXT_PUBLIC_SUPABASE_URL: storage.url });
  const settled = await waitFor(async () => {
    const v = await video(w, id);
    return v.status === "ready" || v.status === "failed" ? v : null;
  }, 120_000, 500);
  assert.ok(settled, `the transcode never finished: ${JSON.stringify(await video(w, id))}\n${worker.output()}`);
  assert.equal(settled.status, "ready", `the transcode failed: ${settled.processing_log}\n${worker.output()}`);
  await worker.kill();
  return { id, v: settled, output: worker.output() };
}

test(
  "F09: a transcode that succeeds clears the failure note an earlier attempt left",
  { skip, timeout: 180_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      // Attempt 2 of 3, after attempt 1 left its note.
      const { v } = await transcodeOnce(w, {
        source: makeSource("retried.mp4"),
        processingLog: "attempt failed, retrying: Error: sign videos-original/x.mp4: fetch failed",
        attempts: 1,
      });
      assert.equal(v.processing_log, null, `a ready video still carries an old failure: ${v.processing_log}`);
    });
  },
);

test(
  "F144: the worker uploads the whole ladder and points the video at its master playlist",
  { skip, timeout: 180_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const { id, v } = await transcodeOnce(w, { source: makeSource("ladder.mp4", "1280x720") });
      const prefix = `hls/${id}/`;
      const keys = storage.keys("videos-hls", prefix).map((k) => k.slice(prefix.length));
      for (const name of ["master.m3u8", "v0.m3u8", "v1.m3u8", "v2.m3u8", "v0_00000.ts", "v1_00000.ts", "v2_00000.ts"]) {
        assert.ok(keys.includes(name), `${name} was not uploaded (got ${keys.join(", ")})`);
      }
      assert.equal(v.hls_master_key, `${prefix}master.m3u8`, "the video must point at the master, or the player sees one rendition");
      const master = storage.get("videos-hls", `${prefix}master.m3u8`)!.body.toString();
      assert.equal((master.match(/#EXT-X-STREAM-INF/g) ?? []).length, 3);
      const [row] = await w.q<{ kind: string }>(`SELECT kind FROM ${w.schema}.files WHERE object_key = $1`, [`${prefix}master.m3u8`]);
      assert.equal(row?.kind, "hls_master");
    });
  },
);
