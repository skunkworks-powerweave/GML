// ffmpeg HLS transcode: a 240p / 360p / 480p ladder.
//
// Input:  a source video in Supabase Storage (videos-original)
// Output: a master playlist, a media playlist and segments per rendition in
//         videos-hls (encode.ts has the ladder and the layout), a poster frame
//         in posters, and the dimensions/duration the UI has always claimed to
//         show.
//
// From ~250 kbps all in (240p) to ~860 kbps (480p video + 64 kbps mono AAC),
// so a 2G link has a rendition it can carry and Ladakh 3G keeps its 480p.
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
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { db } from "@gml/db";
import { boundedError, PermanentJobError, type QueueTx, type ReapedJob } from "@gml/db/queue";
import { files, transcodeJobs, videoSubmissions } from "@gml/db/schema";
import { BUCKETS, hlsPrefix, hlsMasterPlaylistKey, posterKey } from "@gml/shared/storage/buckets";
import { putObject, getObjectStream } from "@gml/shared/storage/client";
import {
  commandFailure,
  commandTimedOut,
  encodeDeadlineMs,
  hlsEncodeArgs,
  ladderFor,
  parseProbe,
  posterArgs,
  probeArgs,
  PROBE_DEADLINE_MS,
  renditionProbeArgs,
  renditionProblem,
  unreadableSource,
  variantFirstSegment,
  type Probe,
} from "./encode.js";
import type { TranscodeJobInput } from "./index.js";

/**
 * A Storage client. With `signal`, every request it makes -- signing, upload,
 * listing -- is aborted when the signal is: a shutdown must not wait on a
 * Storage that has stopped answering (see transcode480p).
 */
function supabase(signal?: AbortSignal) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set for the worker to reach Storage.",
    );
  }
  const abortable: typeof fetch | undefined = signal
    ? (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
    : undefined;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(abortable ? { global: { fetch: abortable } } : {}),
  });
}

/** A handle that can write the domain rows: the shared `db`, or a transaction. */
type Writer = Pick<QueueTx, "update">;

/**
 * Close every attempt of a submission that still claims to be running.
 *
 * Safe to call whenever no attempt of this submission can be live: every
 * producer enqueues with the dedupe key `submission:<id>`, so there is at most
 * one live job per submission, and the caller is that job (or the reaper,
 * which has just taken it back from a dead worker).
 */
async function closeRunningAttempts(w: Writer, videoSubmissionId: string, reason: string): Promise<void> {
  await w
    .update(transcodeJobs)
    .set({ status: "failed", endedAt: new Date(), error: reason })
    .where(and(eq(transcodeJobs.videoSubmissionId, videoSubmissionId), eq(transcodeJobs.status, "running")));
}

/**
 * Repair the domain rows of a transcode attempt whose worker died: the lease
 * reaper's `onReaped`, run in its transaction (a savepoint per job).
 *
 * A SIGKILL, an OOM kill, or a deploy that outlasts Docker's stop grace ends an
 * attempt without its catch block running, and the reaper only ever repaired
 * the transport row. So the attempt's ledger row stayed 'running' forever and
 * its video 'transcoding' -- which the teacher's page renders as "Transcoding in
 * progress" -- and once attempts ran out, /admin/transcode-jobs showed a
 * 'running' row with no Retry or Drop, because both act on a failed row.
 */
export async function repairReapedTranscodes(tx: QueueTx, job: ReapedJob): Promise<void> {
  if (job.name !== "transcode") return;
  const videoSubmissionId = String(job.payload.videoSubmissionId ?? "");
  if (!videoSubmissionId) return;
  const reason = job.dead
    ? "worker stopped responding (lease expired); attempts exhausted"
    : "worker stopped responding (lease expired); retrying";
  await closeRunningAttempts(tx, videoSubmissionId, reason);
  await tx
    .update(videoSubmissions)
    .set(job.dead ? { status: "failed", processingLog: reason } : { status: "queued" })
    .where(
      and(
        eq(videoSubmissions.id, videoSubmissionId),
        // Never over a result: a 'ready' video whose succeed() write was lost
        // (see runJob) is left ready here, and the requeued re-run finds it
        // ready and does nothing (transcode480p).
        inArray(videoSubmissions.status, job.dead ? ["queued", "transcoding"] : ["transcoding"]),
      ),
    );
}

/**
 * Fail the rows of transcode attempts that nothing is running any more: a
 * ledger row 'running', or a video 'transcoding', whose submission has no live
 * job (queued or running) at all. Run on every housekeeping tick.
 *
 * Only a handler holding a live job writes either value, and every way that
 * job can end rewrites them first -- except the ones this is for: rows a killed
 * attempt left before the reaper repaired anything (their jobs since
 * dead-lettered, or pruned), a reaper repair that failed (repairError), and a
 * last write that never landed. Nothing touched those again. The teacher's
 * page said "Transcoding in progress" for good, and /admin/transcode-jobs
 * offered neither Retry nor Drop, which both need a latest attempt that failed.
 * A stranded video without such a row gets one, so the DLQ lists it.
 *
 * The same goes for a video already 'failed' by a transcode that died with no
 * failed attempt on record -- the last attempt's row 'cancelled' by a shutdown
 * whose release() never landed (the reaper then dead-lettered the job), or
 * never written at all because the ledger refused the insert. Those were
 * failed without a failed latest row, so the DLQ offered neither verb, and a
 * direct upload had no way back. Only for a video whose transcode job is DEAD:
 * a WhatsApp fetch or an upload that failed never reached a transcode, and a
 * Retry could only transcode bytes that are not there. An operator's
 * 'dropped' is a decision, and is left alone.
 *
 * One statement, so every part sees the same snapshot: the insert skips the
 * videos whose running row the first part has just failed. Idempotent, and safe
 * beside a second worker running the same statement.
 */
export async function repairStrandedTranscodes(): Promise<{ attempts: number; videos: number }> {
  const reason = "interrupted: no worker is running this attempt any more (its job ended or is gone)";
  const noLiveJob = (submissionId: unknown) => sql`NOT EXISTS (
    SELECT 1 FROM jobs
     WHERE jobs.queue = 'transcode' AND jobs.status IN ('queued', 'running')
       AND jobs.dedupe_key = 'submission:' || ${submissionId}::text)`;
  const latestAttempt = (submissionId: unknown) => sql`COALESCE((
    SELECT t.status FROM ${transcodeJobs} t WHERE t.video_submission_id = ${submissionId}
     ORDER BY t.created_at DESC, t.id DESC LIMIT 1), '')`;
  const res = await db.execute<{ attempts: number; videos: number }>(sql`
    WITH attempts AS (
      UPDATE ${transcodeJobs} SET status = 'failed', ended_at = now(), error = ${reason}
       WHERE ${transcodeJobs.status} = 'running' AND ${noLiveJob(transcodeJobs.videoSubmissionId)}
       RETURNING video_submission_id
    ), videos AS (
      UPDATE ${videoSubmissions} SET status = 'failed', processing_log = ${reason}
       WHERE ${videoSubmissions.status} = 'transcoding' AND ${noLiveJob(videoSubmissions.id)}
       RETURNING id
    ), recorded AS (
      INSERT INTO ${transcodeJobs} (video_submission_id, profile, status, ended_at, error)
      SELECT v.id, '480p', 'failed', now(), ${reason} FROM videos v
       WHERE NOT EXISTS (SELECT 1 FROM attempts a WHERE a.video_submission_id = v.id)
         AND ${latestAttempt(sql`v.id`)} <> 'failed'
      RETURNING id
    ), unrecorded AS (
      INSERT INTO ${transcodeJobs} (video_submission_id, profile, status, ended_at, error)
      SELECT v.id, '480p', 'failed', now(), COALESCE(v.processing_log, 'failed with no attempt on record')
        FROM ${videoSubmissions} v
       WHERE v.status = 'failed' AND ${noLiveJob(sql`v.id`)}
         AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.video_submission_id = v.id)
         AND EXISTS (SELECT 1 FROM jobs WHERE jobs.queue = 'transcode' AND jobs.status = 'dead'
                       AND jobs.dedupe_key = 'submission:' || v.id::text)
         AND ${latestAttempt(sql`v.id`)} NOT IN ('failed', 'dropped')
      RETURNING id
    )
    SELECT (SELECT count(*) FROM attempts)::int AS attempts,
           ((SELECT count(*) FROM videos) + (SELECT count(*) FROM unrecorded))::int AS videos
  `);
  const [row] = (res as unknown as { rows: { attempts: number; videos: number }[] }).rows ?? [];
  return { attempts: row?.attempts ?? 0, videos: row?.videos ?? 0 };
}

/**
 * `finalAttempt` is whether the queue will give up if this attempt fails. The
 * video's status is what the teacher's page renders, and this catch used to
 * write 'failed' on EVERY attempt -- "Transcode failed. Contact your programme
 * admin.", an invitation to re-upload for hours on 2G -- while the queue was
 * about to try again by itself. With a retry to come the video stays 'queued',
 * which the page shows as in progress.
 *
 * `signal` aborts the attempt when the worker is shutting down: every Storage
 * request (signing, the download, the uploads), ffprobe and ffmpeg stop, the
 * attempt is recorded 'cancelled' rather than failed, the video goes back to
 * 'queued', and scratch is removed -- the caller then hands the job back to the
 * queue (see runJob). The Storage requests used to be out of its reach: one
 * that never answered held the drain past its deadline, and the worker exited
 * without handing the job back.
 */
export async function transcode480p(
  input: TranscodeJobInput,
  opts: { finalAttempt: boolean; signal?: AbortSignal } = { finalAttempt: true },
): Promise<void> {
  const { videoSubmissionId, objectKey } = input;
  const { signal } = opts;

  // EVERYTHING after the ledger row exists is inside the try, and so is the
  // ledger insert. The 'transcoding' write and mkdtemp used to run before it,
  // so a transient DB error or a full scratch disk there skipped the catch
  // below and left the attempt 'running' forever, exactly as a SIGKILL does.
  let jobRowId: string | undefined;
  let workDir: string | undefined;
  try {
    // A second delivery of a transcode that already finished: its succeed()
    // write was lost (see runJob), and the reaper requeued the job. This used
    // to announce 'transcoding' over the playable video -- the playlist route
    // refuses anything not 'ready' -- and, if the re-run failed, mark it
    // failed. No producer enqueues a transcode for a ready video on purpose.
    const [current] = await db
      .select({ status: videoSubmissions.status, hlsMasterKey: videoSubmissions.hlsMasterKey })
      .from(videoSubmissions)
      .where(eq(videoSubmissions.id, videoSubmissionId));
    if (current?.status === "ready" && current.hlsMasterKey) {
      console.warn(`[transcode] ${videoSubmissionId} is ready already (a re-delivered job); nothing to do`);
      return;
    }

    // An attempt killed before this one left its row 'running'. The reaper
    // closes those as it requeues them; this catches any it could not (rows
    // from before it did, a drain that ran out of time).
    await closeRunningAttempts(
      db,
      videoSubmissionId,
      "superseded: the previous attempt stopped without finishing (worker killed or restarted)",
    );
    const [jobRow] = await db
      .insert(transcodeJobs)
      .values({
        videoSubmissionId,
        profile: "480p",
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: transcodeJobs.id });
    jobRowId = jobRow!.id;

    // After the ledger row, so a worker with no Storage configuration records
    // WHY on a row the DLQ shows, rather than failing where nothing looks.
    const sb = supabase(signal);

    // Announce the transition. The UI has always had a 'transcoding' chip and it
    // has never once been shown, because nothing wrote the value.
    await db
      .update(videoSubmissions)
      .set({ status: "transcoding" })
      .where(eq(videoSubmissions.id, videoSubmissionId));

    workDir = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
    const localInput = join(workDir, "input");
    const localOut = join(workDir, "out");
    const localPoster = join(workDir, "poster.jpg");

    // ── 1. Source to disk, streamed ──────────────────────────────────────────
    const src = await getObjectStream(sb, BUCKETS.videosOriginal, objectKey, { signal });
    await pipeline(Readable.fromWeb(src.body as never), createWriteStream(localInput), { signal });
    const srcStat = await stat(localInput);
    if (srcStat.size === 0) throw new Error("source object is empty");

    await mkdir(localOut, { recursive: true });

    // ── 2. Probe, for metadata and for the poster timestamp ──────────────────
    const probe = await ffprobe(localInput, signal);
    // A source ffprobe cannot open, or one with no picture, fails the same way
    // on every attempt: say so in words a teacher can read, and do not spend
    // the other attempts re-downloading it. (An audio-only file used to be
    // published as a "video" with no picture and no poster.)
    if (probe.unreadable) {
      throw new PermanentJobError(`This file could not be read as a video (${probe.unreadable}).`);
    }
    if (probe.hasVideo === false) {
      throw new PermanentJobError("This file has no picture, so it is not a video (is it an audio recording?).");
    }

    // ── 3. Transcode ─────────────────────────────────────────────────────────
    // The encoder settings are in encode.ts, where they can be tested.
    await runFfmpeg(hlsEncodeArgs(localInput, localOut, probe), signal, deadline(encodeDeadlineMs(probe.durationSec)));

    // ffmpeg exiting 0 proves it wrote something, not that a phone can play
    // it. Refuse an undecodable rendition here -- any rung, since a player may
    // pick any -- before anything is uploaded or marked ready, so it takes the
    // failure path with a reason attached.
    for (let i = 0; i < ladderFor(probe).length; i += 1) {
      const problem = renditionProblem(
        await run("ffprobe", renditionProbeArgs(join(localOut, variantFirstSegment(i))), signal, deadline(PROBE_DEADLINE_MS)),
      );
      if (problem) throw new Error(`rendition ${i}: ${problem}`);
    }

    // ── 4. Poster frame ──────────────────────────────────────────────────────
    // Best-effort: a video with no usable frame at the chosen timestamp should
    // still become watchable. Taken 10% in rather than at 0s, because the first
    // frame of a classroom recording is usually a hand over the lens.
    let posterUploaded = false;
    try {
      const at = probe.durationSec && probe.durationSec > 2 ? probe.durationSec * 0.1 : 0;
      await runFfmpeg(posterArgs(localInput, localPoster, at), signal, deadline(PROBE_DEADLINE_MS));
      await putObject(
        sb,
        BUCKETS.posters,
        posterKey(videoSubmissionId),
        await readFile(localPoster),
        "image/jpeg",
      );
      posterUploaded = true;
    } catch (err) {
      console.warn(`[transcode] poster failed for ${videoSubmissionId}:`, boundedError(String(err), 300));
    }

    // ── 5. Upload the playlists and every segment ────────────────────────────
    // The ladder's layout is flat (encode.ts), so this is every file in `out`.
    const prefix = hlsPrefix(videoSubmissionId);
    const outFiles = (await readdir(localOut)).sort();
    let bytes = 0;
    for (const fname of outFiles) {
      signal?.throwIfAborted();
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
    // The video points at the MASTER playlist, so the player sees the whole
    // ladder. (Videos transcoded before it point at their single index.m3u8,
    // and the playlist route serves both.)
    const playlistKey = hlsMasterPlaylistKey(videoSubmissionId);

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
        // An earlier attempt's failure text must not outlive the success.
        processingLog: null,
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
      .where(eq(transcodeJobs.id, jobRowId));

    console.log(
      `[transcode] ${videoSubmissionId} ready — ${ladderFor(probe).map((r) => r.name).join("/")}, ` +
        `${outFiles.filter((f) => f.endsWith(".ts")).length} segments, ` +
        `${Math.round(bytes / 1024)} KiB, ${probe.durationSec ?? "?"}s, ` +
        `${probe.width ?? "?"}x${probe.height ?? "?"}`,
    );
  } catch (err) {
    if (signal?.aborted) {
      // Not a failure of this video: the worker is going away and the job goes
      // back to the queue untouched. 'cancelled' is what the ledger's CHECK
      // has for exactly this.
      console.warn(`[transcode] ${videoSubmissionId} interrupted by worker shutdown; handing it back`);
      if (jobRowId) {
        // Only while it is still running: a row the reaper has already failed
        // (its lease lapsed while this handler lived on) must stay failed.
        await db
          .update(transcodeJobs)
          .set({ status: "cancelled", endedAt: new Date(), error: "interrupted: the worker was shut down" })
          .where(and(eq(transcodeJobs.id, jobRowId), eq(transcodeJobs.status, "running")))
          .catch(() => undefined);
      }
      await db
        .update(videoSubmissions)
        .set({ status: "queued" })
        .where(and(eq(videoSubmissions.id, videoSubmissionId), eq(videoSubmissions.status, "transcoding")))
        .catch(() => undefined);
      throw err;
    }
    console.error(`[transcode] ${videoSubmissionId} failed:`, err);
    // The first line says what failed; the END is where the tool's verdict is.
    const msg = boundedError(String(err), 4000);
    if (jobRowId) {
      await db
        .update(transcodeJobs)
        .set({ status: "failed", endedAt: new Date(), error: msg })
        .where(eq(transcodeJobs.id, jobRowId))
        .catch(() => undefined);
    }
    // A permanent failure is the last attempt, however many remain.
    const final = opts.finalAttempt || err instanceof PermanentJobError;
    await db
      .update(videoSubmissions)
      .set(
        final
          ? { status: "failed", processingLog: msg }
          : { status: "queued", processingLog: `attempt failed, retrying: ${msg}` },
      )
      // Never over a result: a video this attempt made ready before a later
      // write threw (the ledger's 'succeeded') is playable, and stays so.
      .where(and(eq(videoSubmissions.id, videoSubmissionId), ne(videoSubmissions.status, "ready")))
      .catch(() => undefined);
    throw err;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Duration and dimensions, or nulls.
 *
 * Never throws. When ffprobe could not open the source as media at all it
 * says so in `unreadable` (the caller fails the job, permanently); any other
 * probe failure only costs the metadata, and ffmpeg's own diagnostics decide.
 */
async function ffprobe(path: string, signal?: AbortSignal): Promise<Probe & { unreadable?: string | null }> {
  try {
    return parseProbe(await run("ffprobe", probeArgs(path), signal, deadline(PROBE_DEADLINE_MS)));
  } catch (err) {
    // A shutdown is not a probe failure: let the attempt be handed back.
    if (signal?.aborted) throw err;
    console.warn("[transcode] ffprobe failed:", boundedError(String(err), 300));
    // A probe killed at its deadline would hang the same way on every attempt
    // -- the same bytes, the same demuxer -- so it is a source ffprobe cannot
    // read, and the job is not retried into the same hang.
    const unreadable = err instanceof CommandTimeout ? err.message.split("\n")[0]! : unreadableSource(String(err));
    return { durationSec: null, width: null, height: null, unreadable };
  }
}

function runFfmpeg(args: string[], signal: AbortSignal | undefined, deadlineMs: number): Promise<void> {
  return run("ffmpeg", args, signal, deadlineMs).then(() => undefined);
}

/**
 * A command's deadline (encode.ts), or TRANSCODE_DEADLINE_MS in its place when
 * that is set: a test cannot wait minutes for a stand-in ffprobe that never
 * exits.
 */
function deadline(ms: number): number {
  const override = Number.parseInt(process.env.TRANSCODE_DEADLINE_MS ?? "", 10);
  return override > 0 ? override : ms;
}

/** A command that was still running at its deadline, and was killed (see run()). */
export class CommandTimeout extends Error {
  override name = "CommandTimeout";
}

/**
 * Spawn a binary, capture stdout, reject with the tail of stderr on failure.
 * An aborted `signal` kills the child (SIGTERM) and rejects with an AbortError.
 *
 * A child still running at `deadlineMs` is killed (SIGKILL: a looping demuxer
 * need not be listening for anything gentler) and it rejects with a
 * CommandTimeout. There was no deadline: runJob heartbeats the lease for as
 * long as the handler waits, so an ffprobe or ffmpeg that never exited held
 * its job 'running' -- and with WORKER_CONCURRENCY=1 every other video behind
 * it -- until someone restarted the worker, which then handed the job back
 * uncounted to hang again. A CommandTimeout is an ordinary failure of the
 * attempt, not a shutdown: it is recorded, counted, and ends in the DLQ.
 */
function run(bin: string, args: string[], signal: AbortSignal | undefined, deadlineMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      // Bounded: ffmpeg emits a progress line per frame, and an hour-long
      // source would otherwise accumulate tens of megabytes of it in memory on
      // the one code path that only matters when something has gone wrong.
      stderr = (stderr + c.toString()).slice(-8000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // On 'exit' for a killed child, not 'close': 'close' also waits for its
    // output pipes, which anything the child started may still hold open.
    child.on("exit", () => {
      clearTimeout(timer);
      if (timedOut) reject(new CommandTimeout(commandTimedOut(bin, deadlineMs, stderr)));
    });
    child.on("close", (code) => {
      if (timedOut) return;
      if (code === 0) resolve(stdout);
      else reject(new Error(commandFailure(bin, code, stderr)));
    });
  });
}

/** Scratch directories this module creates, one per attempt, under tmpdir(). */
const SCRATCH_PREFIX = "gml-transcode-";

/**
 * Remove the scratch a hard-killed attempt left behind. Run at startup.
 *
 * Scratch is removed in transcode480p's `finally`, which a SIGKILL or an OOM
 * kill never reaches, and /tmp is the persistent worker_scratch volume -- so
 * each such kill left the whole source (up to 2 GB) and a partial HLS output
 * on disk for good, and nothing ever looked for it. A directory counts as
 * abandoned only when neither it nor anything directly in it has changed for
 * `olderThanMs` (the lease: past that, the reaper has taken its job back), so a
 * second worker sharing the volume never loses the directory it is writing.
 * Returns how many were removed.
 */
export async function sweepStaleScratch(olderThanMs: number): Promise<number> {
  const root = tmpdir();
  let removed = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const dir = join(root, name);
    try {
      let newest = (await stat(dir)).mtimeMs;
      for (const child of await readdir(dir)) {
        newest = Math.max(newest, (await stat(join(dir, child))).mtimeMs);
      }
      if (Date.now() - newest < olderThanMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Gone already, or not ours to read: leave it.
    }
  }
  return removed;
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
