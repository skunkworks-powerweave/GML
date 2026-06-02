// Redis sliding-window rate limit.
// Key shape: rl:<bucket>:<id>. Stores ZADD timestamps; checks count in window.
//
// Spec 163 — Workflow Run 15 audit-closure NIT: document the fail-closed
// contract at the top of this module so future callers can rely on it.
//
/**
 * # Rate limit — FAIL-CLOSED contract
 *
 * `rateLimit()` deliberately FAILS CLOSED: if Redis is unavailable
 * (no `REDIS_URL` env, connection refused, command timeout, MULTI
 * exec returning null), the function THROWS rather than returning
 * `{ ok: true }`. Callers MUST treat the throw as "request denied"
 * rather than "request allowed":
 *
 *   try {
 *     const r = await rateLimit({ bucket, id, limit, windowMs });
 *     if (!r.ok) return new Response("rate limited", { status: 429 });
 *   } catch (err) {
 *     // Redis down → deny rather than fall through to the handler.
 *     // This is the explicit spec 141 fail-closed contract.
 *     return new Response("rate limiter unavailable", { status: 503 });
 *   }
 *
 * The fail-closed shape was chosen (spec 141 — auth-fail-closed-and-
 * gate-audit) because the alternative (fail-open: treat a Redis
 * outage as "everyone gets through") would let an attacker take down
 * Redis to bypass per-IP login rate limits. Fail-closed degrades the
 * UX (legitimate users get 503 during a Redis outage) but preserves
 * the security boundary.
 *
 * Concretely the throws come from:
 *   - `client()` if `REDIS_URL` is unset — `new Error("REDIS_URL not set")`.
 *   - The underlying ioredis client on connection / command failure.
 *   - The explicit `throw new Error("rate-limit: multi exec returned
 *     null")` below when the MULTI pipeline returns null (a defensive
 *     check; in practice this only happens if ioredis is in a broken
 *     state).
 *
 * If your handler needs a DIFFERENT failure mode (e.g. you'd rather
 * allow the request through on Redis outage because the endpoint is
 * non-security-sensitive), wrap the call in your OWN try/catch and
 * pick the open behaviour explicitly — don't change the default here.
 */

import Redis from "ioredis";

let _client: Redis | null = null;

function client(): Redis {
  if (_client) return _client;
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL not set");
  }
  _client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  return _client;
}

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
};

/**
 * Fixed-windowed sliding rate limit using Redis ZSET.
 * Each call: prune entries older than windowMs, count, add current ts if under limit.
 */
export async function rateLimit({
  bucket,
  id,
  limit,
  windowMs,
}: RateLimitOptions): Promise<RateLimitResult> {
  const r = client();
  const key = `rl:${bucket}:${id}`;
  const now = Date.now();
  const cutoff = now - windowMs;

  const multi = r.multi();
  multi.zremrangebyscore(key, 0, cutoff);
  multi.zcard(key);
  const results = await multi.exec();
  if (!results) throw new Error("rate-limit: multi exec returned null");
  const count = Number(results[1]?.[1] ?? 0);

  if (count >= limit) {
    // find oldest entry to compute retry-after
    const oldest = await r.zrange(key, 0, 0, "WITHSCORES");
    const oldestTs = oldest.length >= 2 ? Number(oldest[1]) : now;
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(0, oldestTs + windowMs - now),
    };
  }

  // record this attempt
  await r.zadd(key, now, `${now}-${Math.random().toString(36).slice(2)}`);
  await r.pexpire(key, windowMs);
  return {
    ok: true,
    remaining: limit - count - 1,
    retryAfterMs: 0,
  };
}
