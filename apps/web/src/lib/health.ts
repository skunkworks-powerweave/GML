// Sub-system health pings used by /api/health.

// Data only: importing it opens nothing (the pool is imported lazily below).
import migrationsJournal from "@gml/db/migrations/journal";
import { BUCKETS } from "@gml/shared/storage/buckets";
import { UNRESOLVED_DEAD_SQL } from "@gml/db/queue";

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
 * Both database probes below go through the APPLICATION'S OWN POOL
 * (packages/db/src/client.ts), so they fail exactly when the app's queries do.
 *
 * They used to build a private pg.Pool from DATABASE_URL. The app's pool does
 * not use the URL alone: with no `sslmode` in it, it forces TLS for the
 * Supabase pooler. The probes' pools did not, so against a Postgres without TLS
 * every page returned 500 ("The server does not support SSL connections")
 * while /api/health reported `db: true`. A new pool per probe also opened and
 * tore down a connection every 30 seconds for nothing.
 *
 * Earlier still, they connected with POSTGRES_* variables rather than
 * DATABASE_URL:
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
  if (!process.env.DATABASE_URL) return { ok: false, detail: "DATABASE_URL not set" };
  try {
    // The pool's own connectionTimeoutMillis (5s) bounds a hung connect.
    const { getPool } = await import("@gml/db");
    await getPool().query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
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
    // Every bucket the app writes: a hand-written list left out
    // scorm-packages, so a deployment without it reported healthy while
    // every SCORM upload and launch failed.
    const missing = Object.values(BUCKETS).filter((b) => !names.has(b));
    return missing.length === 0
      ? { ok: true }
      : { ok: false, detail: `missing buckets: ${missing.join(", ")}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * WhatsApp ingest: how it is configured, and whether it is working.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Nothing reported this. With WHATSAPP_APP_SECRET set and WHATSAPP_ACCESS_TOKEN
 * empty -- the state docker-compose accepts -- the webhook accepted every video
 * and none could be fetched, while /api/health said ok. The secret switches the
 * webhook ON; the verify token is what Meta's handshake checks; the access
 * token is what fetches media and sends replies; the phone number id is what
 * replies are sent from. Each one missing breaks something different, so each
 * is named.
 *
 * NOT part of readiness. WhatsApp is switched on after go-live, so "off" is a
 * legitimate state for a healthy LMS, and a Meta problem must not restart the
 * web container. This is reported beside the probes, never ANDed into `ok`.
 *
 * Names only, never values.
 */
export type WhatsAppHealth = {
  state: "off" | "partial" | "on";
  /** The WHATSAPP_* variables that are unset, when the secret is set. */
  missing: string[];
  /** Media fetches waiting for (or being retried by) the worker. */
  pendingFetches: number | null;
  /** Fetches that gave up in the last 24 hours. */
  deadFetches24h: number | null;
  /** The last time a WhatsApp video was fetched into Storage. */
  lastFetchedAt: string | null;
};

const WHATSAPP_REQUIRED = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
] as const;

/** Configuration only: cheap, no database. */
export function whatsappConfig(env: Record<string, string | undefined> = process.env): Pick<WhatsAppHealth, "state" | "missing"> {
  if (!env.WHATSAPP_APP_SECRET?.trim()) return { state: "off", missing: [] };
  const missing = WHATSAPP_REQUIRED.filter((k) => !env[k]?.trim());
  return { state: missing.length === 0 ? "on" : "partial", missing };
}

export async function whatsappHealth(): Promise<WhatsAppHealth> {
  const config = whatsappConfig();
  const out: WhatsAppHealth = { ...config, pendingFetches: null, deadFetches24h: null, lastFetchedAt: null };
  if (!process.env.DATABASE_URL) return out;
  try {
    const { getPool } = await import("@gml/db");
    const q = await getPool().query<{ pending: string; dead: string; last: Date | null }>(`
      SELECT
        (SELECT count(*) FROM jobs WHERE queue = 'whatsapp' AND name = 'whatsapp_fetch'
            AND status IN ('queued', 'running'))::text AS pending,
        -- updated_at for a job the lease reaper dead-lettered before it set
        -- completed_at (packages/db/src/queue.ts, reapExpiredLeases).
        (SELECT count(*) FROM jobs WHERE queue = 'whatsapp' AND name = 'whatsapp_fetch'
            AND ${UNRESOLVED_DEAD_SQL} AND coalesce(completed_at, updated_at) > now() - interval '24 hours')::text AS dead,
        (SELECT max(created_at) FROM audit_log WHERE action = 'whatsapp.media.fetched') AS last
    `);
    const row = q.rows[0];
    out.pendingFetches = Number(row?.pending ?? 0);
    out.deadFetches24h = Number(row?.dead ?? 0);
    out.lastFetchedAt = row?.last ? new Date(row.last).toISOString() : null;
  } catch {
    // The database probe reports the database; this stays configuration-only.
  }
  return out;
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
  // Expected: the entries of the journal this build was made from, imported
  // statically so it is part of the build. It was read at request time from
  // paths built on process.cwd(), which Next's file tracer cannot resolve to
  // one file: it counted all of apps/web as reachable from /api/health and
  // copied it -- src, READMEs, tsconfig.tsbuildinfo -- into .next/standalone,
  // and the answer depended on where the process was started.
  const entries = (migrationsJournal as { entries?: unknown[] }).entries;
  const expected = Array.isArray(entries) ? entries.length : 0;

  // Applied: query the drizzle.__drizzle_migrations table, through the app's pool.
  if (!process.env.DATABASE_URL) {
    return { ok: false, applied: 0, expected, error: "DATABASE_URL not set" };
  }
  try {
    const { getPool } = await import("@gml/db");
    try {
      const res = await getPool().query<{ count: string }>(
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
