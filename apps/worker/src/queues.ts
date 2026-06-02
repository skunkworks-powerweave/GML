// Queue producers (no Worker bootstrap, no side-effect-heavy imports).
//
// This file exists so the web app can `import { transcodeQueue } from
// "@gml/worker/queues"` without dragging in the Worker constructors, ffmpeg
// transcode pipeline, or retention scheduler. Importing this module DOES
// open one ioredis connection (BullMQ needs it for Queue producers), but
// that's cheap, lazy at first-use, and safe in a Next.js server route.

import { Queue } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";

// Shared connection for all producer-side queue handles. Workers in
// apps/worker/src/index.ts create their own connection for consumers.
const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

export type TranscodeJobInput = {
  videoSubmissionId: string;
  fileId: string;
  bucket: string;
  objectKey: string;
  /** 'whatsapp' source skips re-encode but still HLS-packages */
  source: "direct" | "whatsapp" | "external_link" | "google_drive";
};

// Spec 151 — Worker hardening (Workflow Run 14 audit closure).
// BullMQ's default for `attempts` is 0 (no retries). For Ladakh 3G links
// where transient ffmpeg / MinIO blips are routine, that means a single
// network hiccup permanently loses the job and the user's video.
//
// The defaults below apply to BOTH queues so every producer call site
// (web app, worker self-enqueue, scheduled cron) inherits the same retry
// policy without each caller having to remember to pass it. Callers can
// still override per-job by passing their own `attempts` / `backoff` in
// the third argument to `.add(name, data, opts)`.
//
//   attempts: 3                    — one original + two retries
//   backoff: exponential, 5s base  — 5s, then 10s, then 20s
//   removeOnComplete:              — keep finished jobs 24h for debugging,
//     { age: 24*3600, count: 100 }   cap at 100 newest to bound Redis size
//   removeOnFail:                  — keep failed jobs a week so we can
//     { age: 7*24*3600 }             inspect them before they age out
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { age: 24 * 3600, count: 100 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const transcodeQueue = new Queue<TranscodeJobInput>("transcode", {
  connection,
  defaultJobOptions,
});

// Retention queue (spec 107 — SM-8 nightly notification purge). The web app
// should not enqueue here directly; the schedule is owned by the worker
// container at startup.
export const retentionQueue = new Queue("retention", {
  connection,
  defaultJobOptions,
});
