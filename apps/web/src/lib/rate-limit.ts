import "server-only";

/**
 * # Rate limit — FAIL-CLOSED contract
 *
 * `rateLimit()` FAILS CLOSED: if the counter cannot be read or written it
 * THROWS rather than returning `{ ok: true }`. Callers MUST treat the throw as
 * "request denied":
 *
 *   try {
 *     const r = await rateLimit({ bucket, id, limit, windowMs });
 *     if (!r.ok) return new Response("rate limited", { status: 429 });
 *   } catch {
 *     return new Response("rate limiter unavailable", { status: 503 });
 *   }
 *
 * Fail-open would let an attacker take down the limiter to bypass per-IP login
 * throttling, so the outage degrades UX rather than the security boundary. If a
 * particular endpoint genuinely prefers fail-open, it wraps this call in its own
 * try/catch and chooses that explicitly -- see api/helpdesk/tickets, which does.
 *
 * ── WHY THIS MOVED OFF REDIS ─────────────────────────────────────────────────
 *
 * The contract above was written, documented at length, and UNREACHABLE. The
 * shared ioredis client was built with `maxRetriesPerRequest: null`, no
 * `commandTimeout`, and the offline queue left at its default of enabled. With
 * Redis down, commands did not reject -- they queued indefinitely. So
 * `rateLimit()` never settled, the `catch` that was supposed to deny never ran,
 * and every login request HUNG until the browser gave up. A limiter whose
 * failure mode is to hang the endpoint it protects is a denial of service with
 * extra steps, and it was the documented fail-closed path that hid it.
 *
 * Postgres removes the failure mode rather than fixing it: the counter now
 * lives in the same database the request already needs, on the same pool, with
 * the same 5-second connection timeout. If it is unreachable the query rejects
 * promptly and the catch runs -- and if the database really is down, the
 * handler had nothing to serve anyway.
 *
 * ── FIXED WINDOW, NOT SLIDING ────────────────────────────────────────────────
 *
 * The Redis version kept a sorted set of timestamps. This keeps a count and a
 * window start, which is less precise: at a window boundary a caller can get
 * 2x the limit across two adjacent windows. For "5 attempts per 15 minutes"
 * that worst case is 10 attempts in 15 minutes, which is not the difference
 * between safe and unsafe. It buys a single atomic statement with no
 * read-modify-write race -- the Redis version counted inside a MULTI and added
 * outside it, so it was racy anyway.
 */

import { sql } from "drizzle-orm";
import { db } from "@gml/db";

export type RateLimitOptions = {
  bucket: string;
  id: string;
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
  /** The window this request was counted in, as the database stores it; for rateLimitRefund. */
  windowStart: string;
};

const keyOf = (bucket: string, id: string) => `${bucket}:${id}`.slice(0, 256);

export async function rateLimit({
  bucket,
  id,
  limit,
  windowMs,
}: RateLimitOptions): Promise<RateLimitResult> {
  const key = keyOf(bucket, id);
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));

  // ONE statement, atomic. The upsert either starts a fresh window (when the
  // stored one has aged out) or increments the live one. Two concurrent
  // requests serialise on the primary key rather than both reading the same
  // count and both deciding they are under the limit.
  const res = await db.execute(sql`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
            WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
            THEN 1
            ELSE rate_limits.count + 1
          END,
          window_start = CASE
            WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
            THEN now()
            ELSE rate_limits.window_start
          END
    RETURNING count, extract(epoch from (window_start + make_interval(secs => ${windowSeconds}) - now())) AS retry_after_s,
              window_start::text AS window_start
  `);

  const rows = (res as unknown as { rows: { count: number; retry_after_s: string; window_start: string }[] }).rows ?? [];
  const row = rows[0];
  // A RETURNING that yields nothing means the statement did not do what it
  // claims to. Throwing here is the fail-closed contract, not a defensive
  // flourish: silently returning ok:true would be the exact fail-open shape
  // this module exists to avoid.
  if (!row) throw new Error("rate-limit: upsert returned no row");

  const count = Number(row.count);
  const retryAfterMs = Math.max(0, Math.round(Number(row.retry_after_s) * 1000));

  const windowStart = row.window_start;

  if (count > limit) {
    return { ok: false, remaining: 0, retryAfterMs, windowStart };
  }
  return { ok: true, remaining: Math.max(0, limit - count), retryAfterMs: 0, windowStart };
}

/**
 * Give back one request rateLimit() counted, for a limit meant to count only
 * some outcomes (the sign-in throttle counts failures: auth.ts). Counting
 * first and refunding after, rather than counting only once the outcome is
 * known, keeps concurrent requests from all passing the check before any is
 * counted.
 *
 * Only the window that counted the request is decremented: if it has since
 * rolled over, the new window never included this request. The text form of
 * window_start keeps its microseconds, which a JS Date would drop.
 */
export async function rateLimitRefund({
  bucket,
  id,
  windowStart,
}: {
  bucket: string;
  id: string;
  windowStart: string;
}): Promise<void> {
  await db.execute(sql`
    UPDATE rate_limits SET count = count - 1
    WHERE key = ${keyOf(bucket, id)} AND window_start = ${windowStart}::timestamptz AND count > 0
  `);
}

// EXPIRED COUNTERS ARE DELETED BY pruneRateLimits() IN @gml/db
// (packages/db/src/scripts/retention.ts), which the worker's nightly retention
// job runs. A copy used to sit here, documented as nightly and called by
// nothing -- and unreachable from the worker, because this file is
// `server-only`. Every row it was meant to remove, each keyed by a client IP,
// was kept forever.
