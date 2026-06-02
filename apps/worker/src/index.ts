// @gml/worker — BullMQ consumer.
// Reads jobs from the `transcode` queue and runs ffmpeg → HLS 480p, then
// uploads segments to MinIO and updates video_submissions to status='ready'.
//
// Also operates the `retention` queue (spec 107 — Tier D1):
//   a daily scheduled repeat job at cron '0 3 * * *' (server-local) that
//   calls deleteOldNotifications() from @gml/db to purge notifications older
//   than 90 days (SM-8). The fixed jobId 'retention:nightly' keeps the
//   schedule unique across worker restarts.
//
// Runs in the `worker` container of docker-compose. Single replica is fine;
// concurrency is set via env.

import "dotenv/config";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { deleteOldNotifications } from "@gml/db/scripts/retention";
import { transcode480p } from "./transcode.js";
import { transcodeQueue, retentionQueue, type TranscodeJobInput } from "./queues.js";

// Re-export queue producers so existing `@gml/worker` consumers keep working.
export { transcodeQueue, retentionQueue, type TranscodeJobInput };

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";

// Spec 151 — Worker hardening: clamp WORKER_CONCURRENCY into [1, 16].
// Pre-fix the env was parsed without bounds so:
//   - WORKER_CONCURRENCY=0   disabled the worker entirely (jobs piled up
//                            forever in Redis with no consumer),
//   - WORKER_CONCURRENCY=NaN parsed as NaN → BullMQ rejected the Worker,
//   - WORKER_CONCURRENCY=999 spawned 999 concurrent ffmpeg processes and
//                            OOM-killed the container.
// The clamp uses `|| 2` after parseInt so a non-numeric env (e.g. "foo")
// falls back to 2 instead of NaN, then Math.max(1, ...) excludes 0, and
// Math.min(..., 16) caps the upper bound at a sane ceiling for a single
// worker container running on a 4-vCPU VPS.
const CONCURRENCY = Math.max(
  1,
  Math.min(parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10) || 2, 16),
);

// Worker-side connection (separate from the producer one in queues.ts so
// consumers and producers can be scaled / observed independently).
const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

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

// Spec 107 — Tier D1: SM-8 retention worker. Concurrency 1 since this is a
// nightly maintenance job; we never want two runs racing each other.
const retentionWorker = new Worker(
  "retention",
  async (job) => {
    if (job.name === "deleteOldNotifications") {
      const deleted = await deleteOldNotifications();
      return { deleted };
    }
    console.warn(`[retention] unknown job name '${job.name}'`);
    return { skipped: true };
  },
  {
    connection,
    concurrency: 1,
  },
);

retentionWorker.on("completed", (job, result) => {
  console.log(`[retention] job ${job.id} completed`, result);
});
retentionWorker.on("failed", (job, err) => {
  console.error(`[retention] job ${job?.id} failed:`, err);
});

// Register the nightly repeat job. BullMQ deduplicates by jobId, so it's safe
// to call this on every worker boot — the schedule persists in Redis. Cron
// '0 3 * * *' = 03:00 every day (server-local timezone).
//
// Spec 151 — Worker hardening: cron timezone semantics.
// Cron evaluates in the server-local TZ. Production servers (the Ladakh
// VPS plus the dev compose stack) use UTC, so 03:00 UTC = 08:30 IST (the
// quietest window of the day for the Ladakh mentors who are the primary
// users — they typically check their classroom devices first thing in
// the morning IST, and 08:30 IST puts the maintenance burst safely
// behind the working day for everyone else). If a deployment ever ships
// to a non-UTC host, set the `TZ` env on the worker container (e.g.
// `TZ=Asia/Kolkata`) to make this implicit dependency explicit; BullMQ
// reads the process timezone via node's Intl APIs at job-creation time.
retentionQueue
  .add(
    "deleteOldNotifications",
    {},
    { repeat: { cron: "0 3 * * *" }, jobId: "retention:nightly" },
  )
  .then(() => {
    console.log(`[retention] nightly schedule registered (cron '0 3 * * *')`);
  })
  .catch((err) => {
    console.error(`[retention] failed to register nightly schedule:`, err);
  });

console.log(`[worker] online · redis=${REDIS_URL} · concurrency=${CONCURRENCY}`);
