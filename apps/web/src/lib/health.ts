// Sub-system health pings used by /api/health.
// Dynamic imports so this module doesn't crash if @gml/db / the queue client / etc. aren't
// installed yet (specs 004+ land them).

export type PingResult = {
  ok: boolean;
  detail?: string;
};

export type MigrationsResult = {
  ok: boolean;
  applied: number;
  expected: number;
  error?: string;
};

export async function pingDb(): Promise<PingResult> {
  const host = process.env.POSTGRES_HOST;
  if (!host) return { ok: false, detail: "POSTGRES_HOST not set" };
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
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    // `finally`, not the happy path only. Previously pool.end() ran solely after
    // a successful query, so every FAILED probe leaked a pg.Pool and its
    // reconnect timers. With a 30s healthcheck interval against a flapping
    // database that accumulates sockets until the process dies -- i.e. the
    // health check itself became the outage. pingMigrations() already had this
    // right; pingDb did not.
    await pool.end().catch(() => undefined);
  }
}

// pingRedis and pingMinio are GONE, along with the services they probed.
//
// Redis was replaced by a Postgres-backed queue and rate limiter, so the
// database probe below now covers both. MinIO was replaced by Supabase
// Storage.
//
// Leaving either behind would have been actively harmful: `ok` in the health
// route is an AND over every probe, so a probe for a service that no longer
// exists reports false forever, /api/health returns 503 permanently, and that
// takes the Docker HEALTHCHECK and the deploy script's readiness wait with it.

/**
 * Can Storage be reached, and is the bucket configuration present?
 *
 * Deliberately a cheap metadata call rather than an object read: the probe runs
 * every 30 seconds from the container healthcheck, and it is answering "is the
 * dependency reachable", not "is every object intact".
 */
export async function pingStorage(): Promise<PingResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return { ok: false, detail: "Supabase env not set" };
  try {
    const res = await fetch(`${url}/storage/v1/bucket`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, detail: `status ${res.status}` };
    const buckets = (await res.json()) as { name: string }[];
    const names = new Set(buckets.map((b) => b.name));
    const missing = ["videos-original", "videos-hls", "posters", "pdfs"].filter(
      (b) => !names.has(b),
    );
    return missing.length === 0
      ? { ok: true }
      : { ok: false, detail: `missing buckets: ${missing.join(", ")}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reports Drizzle migration application state. Compares the count of
 * entries in `packages/db/src/migrations/meta/_journal.json` (the expected
 * migrations baked into the build) against the live row count in
 * `drizzle.__drizzle_migrations` (the table Drizzle creates on migrate).
 *
 * If the live table doesn't exist (e.g. operator forgot to run `pnpm
 * --filter @gml/db run migrate`), returns ok:false with applied:0 and the
 * sentinel error 'drizzle migrations table not found' so the operator can
 * diagnose without needing shell access to the DB.
 */
export async function pingMigrations(): Promise<MigrationsResult> {
  // Expected: count entries in the journal shipped with the build.
  let expected = 0;
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // process.cwd() during `next start` / `next dev` is the repo root in
    // dev and the apps/web folder in standalone builds. Try both.
    const candidates = [
      resolve(process.cwd(), "packages/db/src/migrations/meta/_journal.json"),
      resolve(process.cwd(), "../../packages/db/src/migrations/meta/_journal.json"),
    ];
    let journalRaw: string | null = null;
    for (const p of candidates) {
      try {
        journalRaw = readFileSync(p, "utf8");
        break;
      } catch {
        // try next candidate
      }
    }
    if (journalRaw === null) {
      return {
        ok: false,
        applied: 0,
        expected: 0,
        error: "_journal.json not found",
      };
    }
    const journal = JSON.parse(journalRaw) as { entries?: unknown[] };
    expected = Array.isArray(journal.entries) ? journal.entries.length : 0;
  } catch (err) {
    return {
      ok: false,
      applied: 0,
      expected: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Applied: query the drizzle.__drizzle_migrations table.
  const host = process.env.POSTGRES_HOST;
  if (!host) {
    return { ok: false, applied: 0, expected, error: "POSTGRES_HOST not set" };
  }
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
    try {
      const res = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
      );
      const applied = Number(res.rows[0]?.count ?? 0);
      return { ok: applied >= expected, applied, expected };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Postgres error 42P01 = undefined_table. Anything mentioning the
      // table being absent gets the friendly sentinel string the operator
      // can act on.
      if (/does not exist|undefined_table|42P01/i.test(msg)) {
        return {
          ok: false,
          applied: 0,
          expected,
          error: "drizzle migrations table not found",
        };
      }
      return { ok: false, applied: 0, expected, error: msg };
    } finally {
      await pool.end();
    }
  } catch (err) {
    return {
      ok: false,
      applied: 0,
      expected,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
