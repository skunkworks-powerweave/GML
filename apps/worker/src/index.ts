// @gml/worker — BullMQ consumer.
// Reads jobs from the `transcode` queue and runs ffmpeg → HLS 480p, then
// uploads segments to MinIO and updates video_submissions to status='ready'.
//
// Runs in the `worker` container of docker-compose. Single replica is fine;
// concurrency is set via env.

import "dotenv/config";
import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import { transcode480p } from "./transcode.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";
const CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Export a Queue helper so the web app can enqueue without re-importing bullmq.
export const transcodeQueue = new Queue<TranscodeJobInput>("transcode", { connection });

export type TranscodeJobInput = {
  videoSubmissionId: string;
  fileId: string;
  bucket: string;
  objectKey: string;
  /** 'whatsapp' source skips re-encode but still HLS-packages */
  source: "direct" | "whatsapp" | "external_link" | "google_drive";
};

const worker = new Worker<TranscodeJobInput>(
  "transcode",
  async (job) => {
    console.log(`[worker] picking job ${job.id}`, job.data);
    await transcode480p(job.data);
    return { ok: true };
  },
  {
    connection,
    concurrency: CONCURRENCY,
  },
);

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});
worker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err);
});

console.log(`[worker] online · redis=${REDIS_URL} · concurrency=${CONCURRENCY}`);
