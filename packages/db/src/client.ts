// Drizzle client backed by node-postgres (pg) connection pool.
// Lazy-initialised so importing this module is cheap and safe even before
// DATABASE_URL is set (e.g. during type-checking).

import { readFileSync } from "node:fs";
import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

let _pool: Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

/**
 * The connection settings every Postgres client in this repository uses.
 *
 * Exported so that the connections which are NOT this module's pool -- the
 * migrate runner, the seeds, verify-auth.mjs, the worker's healthcheck -- are
 * built from it instead of from a bare connection string. Each of those used to
 * say `new Pool({ connectionString })`, which negotiates no TLS for the
 * documented DATABASE_URL (see sslConfig below): the whole deploy, owner-role
 * DDL included, crossed to the pooler in plaintext, and with Supabase's
 * "Enforce SSL" switched on it could not connect at all.
 * tests/governance/test_db_tls_one_config.test.mjs refuses any other shape.
 */
export function poolConfig(): PoolConfig {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in `.env` (see `.env.example`) before using @gml/db.",
    );
  }
  return {
    connectionString: url,
    ssl: sslConfig(url),
    // Conservative defaults — tune per env if needed.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

/**
 * TLS for the connection to Postgres. NEVER plaintext.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * There was no `ssl` key here at all, and the DATABASE_URL carries no
 * `sslmode`. node-postgres does not negotiate TLS unless asked, so it never
 * sent an SSLRequest and the connection was PLAINTEXT -- across the public
 * internet, to aws-0-ap-south-1.pooler.supabase.com. Measured on the client
 * socket, which is the only place that can see this hop:
 *
 *     no ssl option   clientSocketIsTLS = false
 *     ssl configured  clientSocketIsTLS = true, TLSv1.3,
 *                     TLS_AES_256_GCM_SHA384, issuer "Supabase Inc"
 *
 * `pg_stat_ssl` is the WRONG instrument here and reports `ssl=false` either
 * way: Supavisor terminates the client TLS session itself, so that view
 * describes the pooler-to-Postgres hop, not ours. Checking it is how this
 * would be "verified" and missed.
 *
 * Everything crossed that link in the clear: the database password on every
 * connection, and then every row -- an audit log, guardian contact details,
 * and the names of identifiable children.
 *
 * ── WHY VERIFICATION NEEDS A CA FILE ────────────────────────────────────────
 *
 * Supavisor presents a certificate issued by "Supabase Inc", a PRIVATE root
 * that is not in Node's bundled trust store, so `rejectUnauthorized: true`
 * fails with "self-signed certificate in certificate chain" until that root is
 * supplied. Download it from the dashboard (Project Settings -> Database ->
 * SSL Configuration) and point SUPABASE_CA_CERT at it.
 *
 * With the CA:     encrypted AND authenticated. An on-path attacker cannot
 *                  impersonate the pooler.
 * Without it:      encrypted but UNAUTHENTICATED. A passive eavesdropper is
 *                  defeated; an active MITM is not. Vastly better than
 *                  plaintext, and not the end state -- hence the warning.
 *
 * A `sslmode` already present in the URL wins, so an operator can still say
 * exactly what they mean without editing code.
 */
function sslConfig(url: string): PoolConfig["ssl"] {
  // An explicit sslmode in the connection string is the operator's decision.
  // pg parses it itself; returning undefined leaves it in charge.
  if (/[?&]sslmode=/.test(url)) return undefined;

  const ca = readCaCert();
  if (ca) return { ca, rejectUnauthorized: true };

  if (!warnedAboutUnverifiedTls) {
    warnedAboutUnverifiedTls = true;
    console.warn(
      "[db] TLS is ON but the server certificate is NOT verified. " +
        "Set SUPABASE_CA_CERT to the CA from Project Settings -> Database -> " +
        "SSL Configuration (a path or the PEM itself) to authenticate the pooler.",
    );
  }
  return { rejectUnauthorized: false };
}

let warnedAboutUnverifiedTls = false;

/** The CA as a PEM string, from an inline value or a file path. */
function readCaCert(): string | undefined {
  const raw = process.env.SUPABASE_CA_CERT ?? process.env.PGSSLROOTCERT;
  if (!raw) return undefined;
  if (raw.includes("BEGIN CERTIFICATE")) return raw;
  try {
    return readFileSync(raw, "utf8");
  } catch (err) {
    // Loud, and then fall through to unverified TLS rather than to plaintext.
    console.error(`[db] could not read SUPABASE_CA_CERT from ${raw}: ${String(err)}`);
    return undefined;
  }
}

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool(poolConfig());
    // pg-pool re-emits an IDLE client's error -- the server ending the
    // connection in a pooler restart, a failover, a TCP reset -- as an 'error'
    // event on the Pool, and an EventEmitter with no listener throws it. That
    // was an uncaught exception in whatever process held the pool: the worker
    // (whose polling loops always have idle clients) exited mid-transcode on
    // every such blip. The pool has already discarded the broken client and
    // dials a fresh one on next use, so there is nothing to do but say so.
    // (The Next.js server survived only because Next installs its own
    // uncaughtException handler.)
    _pool.on("error", (err) => {
      console.warn(`[db] an idle pooled connection failed and was discarded: ${err.message}`);
    });
    // ...and the same for a CHECKED-OUT client. pg-pool removes its own
    // listener while it lends a client out, so a backend that dies then -- held
    // between the statements of a transaction, which is how the lease reaper
    // runs -- has its error emitted on the client itself, with nothing
    // listening. Nothing needs doing here: whoever holds the client already
    // gets the error (its query rejects, or its next one does, "not
    // queryable"), and the pool discards an unqueryable client on release.
    _pool.on("connect", (client) => {
      client.on("error", () => undefined);
    });
  }
  return _pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!_db) _db = drizzle(getPool(), { schema });
  return _db;
}

// Convenience handle for the common case.
//
// A direct reference, NOT a Proxy, so `instanceof PgDatabase` checks in
// third-party libraries pass cleanly. The trade-off is that importing this
// module requires DATABASE_URL; use `getDb()` where lazy init is needed.
//
// `buildSafeUrl()` WAS HERE AND IS GONE. It silently rewrote a missing
// DATABASE_URL into
//     postgres://gml:postgres@localhost:5432/gml_lms
// from POSTGRES_* fallbacks, at import time, which made the explicit throw in
// poolConfig() unreachable for this export. A misconfigured deployment
// therefore did not fail at startup with "DATABASE_URL is not set" -- it came
// up, dialled localhost, and produced connection errors that look like a
// network fault rather than a missing variable. On a box where Postgres is not
// even installed any more, that is a confusing error instead of an obvious one.
//
// Builds that legitimately have no database (next build, typecheck) pass a
// throwaway URL explicitly. See docker/app.Dockerfile and .github/workflows.
export const db: NodePgDatabase<typeof schema> = getDb();
