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

/**
 * Both database probes below connect with DATABASE_URL — the SAME string the
 * application itself uses.
 *
 * They used to assemble a connection from POSTGRES_HOST / POSTGRES_PORT /
 * POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD, which is a different
 * database from the one the app talks to. Those could always have pointed
 * somewhere else, and once compose stopped forwarding them (there is no local
 * Postgres any more) they pointed nowhere at all: /api/health reported
 * `db: false, migrations: 0 of 28` against a database that was up, fully
 * migrated, and being queried successfully by the app in the same container.
 *
 * Found by booting the stack and asking it. Nothing static would have caught
 * it, because both sets of variables are perfectly valid names.
 *
 * A health check must probe the dependency the application actually uses. One
 * that probes a different one is worse than none: it reports green when the
 * real dependency is down, and red when it is fine.
 */
export async function pingDb(): Promise<PingResult> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { ok: false, detail: "DATABASE_URL not set" };
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    // 5s, not 2s. The database is in another region now; a 2-second budget
    // turns ordinary latency into a reported outage.
    connectionTimeoutMillis: 5000,
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
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return { ok: false, applied: 0, expected, error: "DATABASE_URL not set" };
  }
  let pool: import("pg").Pool | null = null;
  try {
    const { Pool } = await import("pg");
    pool = new Pool({
      connectionString,
      // 5s, matching pingDb: the database is in another region.
      connectionTimeoutMillis: 5000,
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
