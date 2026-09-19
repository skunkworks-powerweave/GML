// ffmpeg 480p HLS transcode.
//
// Input:  a source video in Supabase Storage (videos-original)
// Output: a media playlist + segments in videos-hls, a poster frame in posters,
//         and the dimensions/duration the UI has always claimed to show.
//
// Targets ~800 kbps total (480p video + 64 kbps mono AAC) for Ladakh 3G.
//
// ── WHAT WAS WRONG WITH THE PREVIOUS VERSION ─────────────────────────────────
//
// 1. RETRIES WERE IMPOSSIBLE BY CONSTRUCTION. It did a plain INSERT into `files`
//    at the deterministic key (bucket, hls/<id>/master.m3u8) against the UNIQUE
//    constraint files_bucket_objectkey_uq. Attempt 1 could get past that insert
//    and fail later; attempts 2 and 3 then died ON the insert. So BullMQ's
//    `attempts: 3` was decorative, and the operator "Retry" button in
//    /admin/transcode-jobs was permanently poisoned for any submission that had
//    produced a files row once. Now an upsert.
//
// 2. THE `-c copy` SHORTCUT FOR WHATSAPP WAS WRONG TWICE. WhatsApp delivers
//    arbitrary phone-camera output: stream-copying non-Annex-B H.264 or non-AAC
//    audio into HLS fails outright, and when it succeeds it preserves a 1080p
//    multi-megabit stream -- defeating the entire low-bandwidth design on the
//    path that is supposed to be the low-bandwidth one. Everything is
//    re-encoded now.
//
// 3. IT BUFFERED THE WHOLE SOURCE IN MEMORY (`transformToByteArray()`), then
//    wrote it to disk through a `readFile().catch(writeFile)` that only worked
//    because the read reliably failed with ENOENT in a fresh mkdtemp. On a 2 GB
//    source that is 2 GB of heap. Now streamed to disk.
//
// 4. duration_sec, width, height and poster_key were NEVER POPULATED -- there
//    was no ffprobe call anywhere in the repository -- so every video rendered
//    its duration as "—", the posters bucket stayed empty, and
//    segmentTtlSeconds() had no duration to scale from.
//
// 5. video_submissions never passed through 'transcoding'. It went received ->
//    ready, so the status existed in the enum, was rendered in the UI, and was
//    unreachable.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { db } from "@gml/db";
import { files, transcodeJobs, videoSubmissions } from "@gml/db/schema";
import { BUCKETS, hlsPrefix, hlsPlaylistKey, posterKey } from "@gml/shared/storage/buckets";
import { putObject, getObjectStream } from "@gml/shared/storage/client";
import type { TranscodeJobInput } from "./index.js";

function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set for the worker to reach Storage.",
    );
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** What ffprobe tells us about the source. All fields optional: a probe that
 *  fails must not fail the transcode, it just costs us the metadata. */
type Probe = { durationSec: number | null; width: number | null; height: number | null };

export async function transcode480p(input: TranscodeJobInput): Promise<void> {
  const { videoSubmissionId, objectKey } = input;
  const sb = supabase();

  const [jobRow] = await db
    .insert(transcodeJobs)
    .values({
      videoSubmissionId,
      profile: "480p",
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: transcodeJobs.id });

  // Announce the transition. The UI has always had a 'transcoding' chip and it
  // has never once been shown, because nothing wrote the value.
  await db
    .update(videoSubmissions)
    .set({ status: "transcoding" })
    .where(eq(videoSubmissions.id, videoSubmissionId));

  const workDir = await mkdtemp(join(tmpdir(), "gml-transcode-"));
  const localInput = join(workDir, "input");
  const localOut = join(workDir, "out");
  const localPoster = join(workDir, "poster.jpg");

  try {
    // ── 1. Source to disk, streamed ──────────────────────────────────────────
    const src = await getObjectStream(sb, BUCKETS.videosOriginal, objectKey);
    await pipeline(Readable.fromWeb(src.body as never), createWriteStream(localInput));
    const srcStat = await stat(localInput);
    if (srcStat.size === 0) throw new Error("source object is empty");

    await mkdir(localOut, { recursive: true });

    // ── 2. Probe, for metadata and for the poster timestamp ──────────────────
    const probe = await ffprobe(localInput);

    // ── 3. Transcode ─────────────────────────────────────────────────────────
    //
    // scale=-2:480 keeps the aspect ratio and forces an EVEN width, which
    // libx264 requires; a bare -1 produces odd widths on some sources and
    // ffmpeg then refuses the encode.
    await runFfmpeg([
      "-y",
      "-i", localInput,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "26",
      "-maxrate", "800k",
      "-bufsize", "1600k",
      "-vf", "scale=-2:480",
      "-c:a", "aac",
      "-b:a", "64k",
      "-ac", "1",
      // Segment boundaries must be keyframe-aligned or players stall at each
      // join. At 6s segments and 25fps that is a keyframe every 150 frames.
      "-g", "150",
      "-keyint_min", "150",
      "-sc_threshold", "0",
      "-hls_time", "6",
      "-hls_playlist_type", "vod",
      "-hls_segment_filename", join(localOut, "seg_%05d.ts"),
      join(localOut, "index.m3u8"),
    ]);

    // ── 4. Poster frame ──────────────────────────────────────────────────────
    // Best-effort: a video with no usable frame at the chosen timestamp should
    // still become watchable. Taken 10% in rather than at 0s, because the first
    // frame of a classroom recording is usually a hand over the lens.
    let posterUploaded = false;
    try {
      const at = probe.durationSec && probe.durationSec > 2 ? probe.durationSec * 0.1 : 0;
      await runFfmpeg([
        "-y",
        "-ss", at.toFixed(2),
        "-i", localInput,
        "-frames:v", "1",
        "-vf", "scale=-2:360",
        "-q:v", "6",
        localPoster,
      ]);
      await putObject(
        sb,
        BUCKETS.posters,
        posterKey(videoSubmissionId),
        await readFile(localPoster),
        "image/jpeg",
      );
      posterUploaded = true;
    } catch (err) {
      console.warn(`[transcode] poster failed for ${videoSubmissionId}:`, String(err).slice(0, 200));
    }

    // ── 5. Upload the playlist and every segment ─────────────────────────────
    const prefix = hlsPrefix(videoSubmissionId);
    const outFiles = (await readdir(localOut)).sort();
    let bytes = 0;
    for (const fname of outFiles) {
      const body = await readFile(join(localOut, fname));
      bytes += body.byteLength;
      await putObject(
        sb,
        BUCKETS.videosHls,
        `${prefix}/${fname}`,
        body,
        fname.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      );
    }

    // ── 6. Record it ─────────────────────────────────────────────────────────
    const playlistKey = hlsPlaylistKey(videoSubmissionId);

    // UPSERT, not INSERT. See note 1 at the top of this file: the plain insert
    // made every retry impossible, because the key is deterministic per
    // submission and the unique constraint is doing its job.
    await db
      .insert(files)
      .values({
        bucket: BUCKETS.videosHls,
        objectKey: playlistKey,
        mimeType: "application/vnd.apple.mpegurl",
        kind: "hls_master",
        status: "stored",
        sizeBytes: bytes,
      })
      .onConflictDoUpdate({
        target: [files.bucket, files.objectKey],
        set: { status: "stored", sizeBytes: bytes, mimeType: "application/vnd.apple.mpegurl" },
      });

    await db
      .update(videoSubmissions)
      .set({
        hlsMasterKey: playlistKey,
        status: "ready",
        verifiedAt: new Date(),
        durationSec: probe.durationSec ?? undefined,
        width: probe.width ?? undefined,
        height: probe.height ?? undefined,
        posterKey: posterUploaded ? posterKey(videoSubmissionId) : undefined,
      })
      .where(eq(videoSubmissions.id, videoSubmissionId));

    await db
      .update(transcodeJobs)
      .set({ status: "succeeded", endedAt: new Date() })
      .where(eq(transcodeJobs.id, jobRow.id));

    console.log(
      `[transcode] ${videoSubmissionId} ready — ${outFiles.length - 1} segments, ` +
        `${Math.round(bytes / 1024)} KiB, ${probe.durationSec ?? "?"}s, ` +
        `${probe.width ?? "?"}x${probe.height ?? "?"}`,
    );
  } catch (err) {
    console.error(`[transcode] ${videoSubmissionId} failed:`, err);
    const msg = String(err).slice(0, 4000);
    await db
      .update(transcodeJobs)
      .set({ status: "failed", endedAt: new Date(), error: msg })
      .where(eq(transcodeJobs.id, jobRow.id))
      .catch(() => undefined);
    await db
      .update(videoSubmissions)
      .set({ status: "failed", processingLog: msg })
      .where(eq(videoSubmissions.id, videoSubmissionId))
      .catch(() => undefined);
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Duration and dimensions, or nulls.
 *
 * Never throws. A source ffprobe cannot read is very likely a source ffmpeg
 * cannot transcode either -- but that should surface as a transcode failure
 * with ffmpeg's own diagnostics, not as an opaque probe error.
 */
async function ffprobe(path: string): Promise<Probe> {
  try {
    const out = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-show_entries", "format=duration",
      "-of", "json",
      path,
    ]);
    const parsed = JSON.parse(out) as {
      streams?: { width?: number; height?: number }[];
      format?: { duration?: string };
    };
    const s0 = parsed.streams?.[0];
    const d = parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : NaN;
    return {
      durationSec: Number.isFinite(d) && d > 0 ? Math.round(d) : null,
      width: s0?.width ?? null,
      height: s0?.height ?? null,
    };
  } catch (err) {
    console.warn("[transcode] ffprobe failed:", String(err).slice(0, 200));
    return { durationSec: null, width: null, height: null };
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return run("ffmpeg", args).then(() => undefined);
}

/** Spawn a binary, capture stdout, reject with the tail of stderr on failure. */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      // Bounded: ffmpeg emits a progress line per frame, and an hour-long
      // source would otherwise accumulate tens of megabytes of it in memory on
      // the one code path that only matters when something has gone wrong.
      stderr = (stderr + c.toString()).slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited ${code}\n${stderr}`));
    });
  });
}

/** Exposed for the retention job: remove a submission's derived output. */
export async function removeDerivedOutput(videoSubmissionId: string): Promise<void> {
  const sb = supabase();
  const prefix = hlsPrefix(videoSubmissionId);
  const { data } = await sb.storage.from(BUCKETS.videosHls).list(prefix, { limit: 1000 });
  const keys = (data ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
  if (keys.length > 0) await sb.storage.from(BUCKETS.videosHls).remove(keys);
  await sb.storage.from(BUCKETS.posters).remove([posterKey(videoSubmissionId)]).catch(() => undefined);
  await db
    .delete(files)
    .where(sql`${files.bucket} = ${BUCKETS.videosHls} AND ${files.objectKey} LIKE ${prefix + "/%"}`);
}
