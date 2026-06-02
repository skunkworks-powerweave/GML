// Web-side Redis singleton.
//
// Spec 170 — Workflow Run 16 post-audit hardening. Before this spec
// landed, every web-side caller that needed a direct ioredis client
// constructed its OWN `new Redis(url, {...})` instance:
//
//   - apps/web/src/lib/rate-limit.ts (rate-limit ZADD pipeline)
//   - apps/web/src/lib/health.ts (the /api/health PING probe)
//
// Two distinct ioredis instances in the same Next.js process opened TWO
// TCP connections to redis, doubled the connection-pool churn, and made
// the failure modes harder to reason about (each call site picked its
// own `connectTimeout`, `maxRetriesPerRequest`, `lazyConnect`). The
// audit follow-up asked for a single shared client so the connection
// surface area is one stable thing.
//
// Scope clarification: this singleton is for DIRECT redis calls only.
// BullMQ queue producers in apps/worker/src/queues.ts have their own
// dedicated `IORedis` connection — BullMQ's contract is that the
// connection passed to a Queue / Worker is owned by that handle and
// must not be shared with arbitrary callers. The worker is a separate
// process anyway, so its connection lifecycle is independent of the
// web app's. The web-side `transcodeQueue.add` / `getJobCounts` calls
// inherit the worker's bundled connection by importing the queue
// module — they do not touch this singleton.
//
// Defaults match the worker's queues.ts shape (maxRetriesPerRequest:
// null, enableReadyCheck: false, lazyConnect: true) so the two
// processes have aligned semantics. lazyConnect is critical for the
// Next.js build step — `next build` imports modules eagerly, and we
// don't want to fail the build just because Redis isn't running at
// build time.

import IORedis from "ioredis";

let _client: IORedis | null = null;

/**
 * Returns the process-wide Redis client, constructing it on first call.
 * Safe to call from any server-side context (route handler, server
 * action, server component). Connection is `lazyConnect: true` so the
 * actual TCP connect happens at first command, not at import.
 */
export function getRedis(): IORedis {
  if (!_client) {
    _client = new IORedis(process.env.REDIS_URL ?? "redis://redis:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }
  return _client;
}

/**
 * Liveness probe for /api/health. Returns `{ ok: true }` on a successful
 * PING reply, `{ ok: false, error: <truncated-message> }` on any
 * failure (connection refused, timeout, AUTH failure, etc). Never
 * throws — health endpoints must always return a JSON shape so the
 * upstream monitor can record a structured failure rather than a 500.
 *
 * The error string is sliced to 200 chars so a verbose ioredis stack
 * trace can't blow up the /api/health response body.
 */
export async function pingRedis(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getRedis().ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}
