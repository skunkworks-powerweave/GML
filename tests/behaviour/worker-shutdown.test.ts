// The worker's SHUTDOWN, executed: what a deploy does to a transcode in flight.
//
// `docker compose up -d` with a new image, a rollback, `docker compose stop`:
// each sends the worker SIGTERM and, after the service's stop grace (Docker's
// default is 10 s), SIGKILL. A transcode takes minutes, so whatever the worker
// does with that signal decides whether a deploy costs a video nothing, or
// fifteen minutes of lease, one of its three attempts, an orphaned ledger row
// and its scratch directory.
//
// Each test starts the REAL worker (see _worker.ts) with its own TMPDIR, so
// what it leaves in scratch is visible, and Storage from _storage.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsDatabase } from "./_harness.js";
import { withWorkerWorld, waitFor, seedJob, seedSubmission, sourceKeyFor } from "./_worker.js";
import { startFakeStorage } from "./_storage.js";

const skip = needsDatabase();
// Node on Windows cannot deliver SIGTERM to a child: kill("SIGTERM")
// terminates it outright, so the handler under test never runs there.
const skipSignals =
  skip || (process.platform === "win32" ? "a child cannot be sent SIGTERM on Windows; this runs on Linux (CI)" : false);

/** The TMPDIR a spawned worker gets, and the env that points it there. */
function scratch(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "gml-worker-scratch-"));
  return { dir, env: { TMPDIR: dir, TEMP: dir, TMP: dir } };
}
const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("gml-transcode-"));

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

/** A two-second clip ffmpeg can transcode, so an attempt gets as far as its uploads. */
function realSource(dir: string): Buffer {
  const out = join(dir, "source.mp4");
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", out,
  ]);
  if (r.status !== 0) throw new Error(`could not make a source: ${r.stderr}`);
  const bytes = readFileSync(out);
  rmSync(out);
  return bytes;
}

test(
  "F115: SIGTERM mid-transcode hands the job straight back, spends no attempt, and leaves no scratch",
  { skip: skipSignals, timeout: 90_000 },
  async () => {
    const storage = await startFakeStorage();
    const tmp = scratch();
    try {
      await withWorkerWorld(async (w) => {
        const sub = await seedSubmission(w, "queued");
        storage.stall("videos-original", sourceKeyFor(sub));
        const jobId = await seedJob(w, sub, { status: "queued", attempts: 0, maxAttempts: 3 });

        const worker = w.spawnWorker({ NEXT_PUBLIC_SUPABASE_URL: storage.url, ...tmp.env });
        const busy = await waitFor(async () => {
          const [v] = await w.q<{ status: string }>(`SELECT status FROM ${w.schema}.video_submissions WHERE id = $1`, [sub]);
          return v!.status === "transcoding" && leftovers(tmp.dir).length > 0;
        }, 30_000);
        assert.ok(busy, `the transcode never started:\n${worker.output()}`);

        const sent = Date.now();
        worker.child.kill("SIGTERM");
        const code = await Promise.race([worker.exited, new Promise((r) => setTimeout(() => r("still running"), 25_000))]);
        const took = (Date.now() - sent) / 1000;

        // Docker SIGKILLs after the stop grace. The drain used to wait up to
        // 30 s for a transcode that takes minutes, so it never finished in time.
        assert.equal(code, 0, `the worker did not exit cleanly on SIGTERM (${String(code)} after ${took}s):\n${worker.output()}`);
        assert.ok(took < 10, `the drain took ${took}s; Docker's default stop grace is 10 s`);

        const [job] = await w.q<{ status: string; attempts: number; lease: boolean; locked_by: string | null }>(
          `SELECT status, attempts, lease_expires_at IS NOT NULL AS lease, locked_by FROM ${w.schema}.jobs WHERE id = $1`,
          [jobId],
        );
        // Straight back to the queue, NOT left 'running' behind a 15-minute
        // lease, and not charged an attempt for an operator's restart.
        assert.deepEqual(job, { status: "queued", attempts: 0, lease: false, locked_by: null });
        const ledger = await w.q<{ status: string }>(
          `SELECT status FROM ${w.schema}.transcode_jobs WHERE video_submission_id = $1`,
          [sub],
        );
        assert.deepEqual(ledger.map((r) => r.status), ["cancelled"], "the interrupted attempt's ledger row");
        const [v] = await w.q<{ status: string }>(`SELECT status FROM ${w.schema}.video_submissions WHERE id = $1`, [sub]);
        assert.equal(v!.status, "queued");
        assert.deepEqual(leftovers(tmp.dir), [], "the interrupted attempt left its scratch directory behind");
      });
    } finally {
      await storage.close();
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  },
);

test(
  "F115: a worker starting up removes scratch a hard-killed attempt left, and only that",
  { skip, timeout: 60_000 },
  async () => {
    const tmp = scratch();
    try {
      await withWorkerWorld(async (w) => {
        // What a SIGKILL or OOM kill leaves: the source (up to 2 GB) and a
        // partial HLS output, on the persistent worker_scratch volume, forever.
        const stale = join(tmp.dir, "gml-transcode-killed");
        mkdirSync(join(stale, "out"), { recursive: true });
        writeFileSync(join(stale, "input"), Buffer.alloc(1024));
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        for (const p of [join(stale, "input"), join(stale, "out"), stale]) utimesSync(p, old, old);
        // One that is being written right now (a second worker on the same
        // volume) must survive.
        const live = join(tmp.dir, "gml-transcode-live");
        mkdirSync(live);

        const worker = w.spawnWorker(tmp.env);
        const swept = await waitFor(async () => !leftovers(tmp.dir).includes("gml-transcode-killed"), 30_000);
        assert.ok(swept, `stale scratch survived startup: ${leftovers(tmp.dir)}\n${worker.output()}`);
        assert.ok(leftovers(tmp.dir).includes("gml-transcode-live"), "a fresh scratch directory was removed");
      });
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  },
);

// The shutdown signal used to reach only the source download's body and ffmpeg.
// Minting the source's signed URL, the fetch waiting for its headers, and each
// upload had no signal at all: a Storage that stopped answering at SIGTERM held
// the drain until DRAIN_DEADLINE_MS (20 s), and the worker then exit(1)ed
// WITHOUT release() -- the fifteen-minute lease and a spent attempt that the
// interrupt exists to avoid. (Docker's own grace is 30 s, so it got that far.)
const HANGS: Array<{ kind: "sign" | "download" | "upload"; what: string }> = [
  { kind: "sign", what: "while Storage is minting the source's signed URL" },
  { kind: "download", what: "while the source's download is waiting for its headers" },
  { kind: "upload", what: "while an HLS upload is waiting for Storage" },
];

for (const h of HANGS) {
  const needsFfmpeg = h.kind === "upload" && !ffmpeg ? "ffmpeg/ffprobe not on PATH -- the attempt must transcode to reach its uploads" : false;
  test(
    `F115: SIGTERM ${h.what} still hands the job straight back, in seconds`,
    { skip: skipSignals || needsFfmpeg, timeout: 120_000 },
    async () => {
      const storage = await startFakeStorage();
      const tmp = scratch();
      try {
        await withWorkerWorld(async (w) => {
          const sub = await seedSubmission(w, "queued");
          storage.put("videos-original", sourceKeyFor(sub), h.kind === "upload" ? realSource(tmp.dir) : Buffer.alloc(1024), "video/mp4");
          if (h.kind === "upload") storage.hang("upload", "videos-hls", `hls/${sub}/`);
          else storage.hang(h.kind, "videos-original", sourceKeyFor(sub));
          const jobId = await seedJob(w, sub, { status: "queued", attempts: 0, maxAttempts: 3 });

          const worker = w.spawnWorker({ NEXT_PUBLIC_SUPABASE_URL: storage.url, ...tmp.env });
          const stuck = await waitFor(async () => storage.hung() > 0, 60_000);
          assert.ok(stuck, `the attempt never reached the hung Storage call:
${worker.output()}`);

          const sent = Date.now();
          worker.child.kill("SIGTERM");
          const code = await Promise.race([worker.exited, new Promise((r) => setTimeout(() => r("still running"), 25_000))]);
          const took = (Date.now() - sent) / 1000;
          assert.equal(code, 0, `the worker did not exit cleanly on SIGTERM (${String(code)} after ${took}s):
${worker.output()}`);
          assert.ok(took < 10, `the drain took ${took}s`);

          const [job] = await w.q<{ status: string; attempts: number; locked_by: string | null }>(
            `SELECT status, attempts, locked_by FROM ${w.schema}.jobs WHERE id = $1`,
            [jobId],
          );
          assert.deepEqual(job, { status: "queued", attempts: 0, locked_by: null }, "the job was not handed back");
          const ledger = await w.q<{ status: string }>(
            `SELECT status FROM ${w.schema}.transcode_jobs WHERE video_submission_id = $1`,
            [sub],
          );
          assert.deepEqual(ledger.map((r) => r.status), ["cancelled"]);
          const [v] = await w.q<{ status: string }>(`SELECT status FROM ${w.schema}.video_submissions WHERE id = $1`, [sub]);
          assert.equal(v!.status, "queued");
          assert.deepEqual(leftovers(tmp.dir), [], "the interrupted attempt left its scratch directory behind");
        });
      } finally {
        await storage.close();
        rmSync(tmp.dir, { recursive: true, force: true });
      }
    },
  );
}
