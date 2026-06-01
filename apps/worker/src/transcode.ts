// ffmpeg 480p HLS transcode (spec 040).
// Input:  MinIO object (bucket + key) — original from teacher upload
// Output: HLS master playlist + .ts segments in gml-videos-hls bucket
// Default ffmpeg params target ~800 kbps total (480p + AAC 64k mono) for
// Ladakh 3G compatibility.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@gml/db";
import { files, transcodeJobs, videoSubmissions } from "@gml/db/schema";
import type { TranscodeJobInput } from "./index.js";

const HLS_BUCKET = process.env.MINIO_BUCKET_HLS ?? "gml-videos-hls";

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ROOT_USER ?? "minioadmin",
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? "minioadmin",
  },
  forcePathStyle: true,
});

export async function transcode480p(input: TranscodeJobInput): Promise<void> {
  const { videoSubmissionId, bucket, objectKey, source } = input;

  // Mark transcode_jobs row as 'running'
  const [jobRow] = await db
    .insert(transcodeJobs)
    .values({
      videoSubmissionId,
      profile: "480p",
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: transcodeJobs.id });

  const workDir = await mkdtemp(join(tmpdir(), "gml-transcode-"));
  const localInput = join(workDir, "input.mp4");
  const localOut = join(workDir, "out");

  try {
    // 1. Download original from MinIO
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (!obj.Body) throw new Error("empty body");
    const buf = await obj.Body.transformToByteArray();
    await readFile(localInput).catch(async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(localInput, buf);
    });

    // 2. ffmpeg → 480p HLS
    // WhatsApp source is already compressed; just package to HLS with -c copy
    const args = source === "whatsapp"
      ? [
          "-y",
          "-i", localInput,
          "-c", "copy",
          "-hls_time", "6",
          "-hls_playlist_type", "vod",
          "-hls_segment_filename", join(localOut, "seg_%03d.ts"),
          join(localOut, "master.m3u8"),
        ]
      : [
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
          "-hls_time", "6",
          "-hls_playlist_type", "vod",
          "-hls_segment_filename", join(localOut, "seg_%03d.ts"),
          join(localOut, "master.m3u8"),
        ];

    const { mkdir } = await import("node:fs/promises");
    await mkdir(localOut, { recursive: true });

    await runFfmpeg(args);

    // 3. Upload HLS master + segments to MinIO
    const hlsKeyPrefix = `hls/${videoSubmissionId}`;
    const outFiles = await readdir(localOut);
    for (const fname of outFiles) {
      const body = await readFile(join(localOut, fname));
      const contentType = fname.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/mp2t";
      await s3.send(
        new PutObjectCommand({
          Bucket: HLS_BUCKET,
          Key: `${hlsKeyPrefix}/${fname}`,
          Body: body,
          ContentType: contentType,
        }),
      );
    }

    // 4. Insert files row for the HLS master + update video_submissions
    const masterKey = `${hlsKeyPrefix}/master.m3u8`;
    await db.insert(files).values({
      bucket: HLS_BUCKET,
      objectKey: masterKey,
      mimeType: "application/vnd.apple.mpegurl",
      kind: "hls_master",
      status: "stored",
    });

    await db
      .update(videoSubmissions)
      .set({
        hlsMasterKey: masterKey,
        status: "ready",
        verifiedAt: new Date(),
      })
      .where(eq(videoSubmissions.id, videoSubmissionId));

    await db
      .update(transcodeJobs)
      .set({ status: "succeeded", endedAt: new Date() })
      .where(eq(transcodeJobs.id, jobRow.id));
  } catch (err) {
    console.error("[transcode] failed:", err);
    await db
      .update(transcodeJobs)
      .set({ status: "failed", endedAt: new Date(), error: String(err) })
      .where(eq(transcodeJobs.id, jobRow.id));
    await db
      .update(videoSubmissions)
      .set({ status: "failed", processingLog: String(err) })
      .where(eq(videoSubmissions.id, videoSubmissionId));
    throw err;
  } finally {
    // Cleanup tmpdir
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}
