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

export const transcodeQueue = new Queue<TranscodeJobInput>("transcode", { connection });

// Retention queue (spec 107 — SM-8 nightly notification purge). The web app
// should not enqueue here directly; the schedule is owned by the worker
// container at startup.
export const retentionQueue = new Queue("retention", { connection });
