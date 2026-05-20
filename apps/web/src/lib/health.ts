// Sub-system health pings used by /api/health.
// Dynamic imports so this module doesn't crash if @gml/db / ioredis / etc. aren't
// installed yet (specs 004+ land them).

export type PingResult = {
  ok: boolean;
  detail?: string;
};

export async function pingDb(): Promise<PingResult> {
  const host = process.env.POSTGRES_HOST;
  if (!host) return { ok: false, detail: "POSTGRES_HOST not set" };
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({
      host,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      connectionTimeoutMillis: 2000,
      max: 1,
    });
    await pool.query("SELECT 1");
    await pool.end();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function pingRedis(): Promise<PingResult> {
  const url = process.env.REDIS_URL;
  if (!url) return { ok: false, detail: "REDIS_URL not set" };
  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, { connectTimeout: 2000, maxRetriesPerRequest: 1, lazyConnect: true });
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    return { ok: pong === "PONG" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function pingMinio(): Promise<PingResult> {
  const endpoint = process.env.MINIO_ENDPOINT;
  if (!endpoint) return { ok: false, detail: "MINIO_ENDPOINT not set" };
  try {
    const res = await fetch(`${endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return { ok: res.ok, detail: res.ok ? undefined : `status ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
