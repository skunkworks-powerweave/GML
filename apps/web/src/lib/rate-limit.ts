// Redis sliding-window rate limit.
// Key shape: rl:<bucket>:<id>. Stores ZADD timestamps; checks count in window.

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
