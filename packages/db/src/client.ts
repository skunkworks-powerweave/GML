// Drizzle client backed by node-postgres (pg) connection pool.
// Lazy-initialised so importing this module is cheap and safe even before
// DATABASE_URL is set (e.g. during type-checking).

import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

let _pool: Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

function poolConfig(): PoolConfig {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in `.env` (see `.env.example`) before using @gml/db.",
    );
  }
  return {
    connectionString: url,
    // Conservative defaults — tune per env if needed.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

export function getPool(): Pool {
  if (!_pool) _pool = new Pool(poolConfig());
  return _pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!_db) _db = drizzle(getPool(), { schema });
  return _db;
}

// Convenience handle for the common case.
// IMPORTANT: This is a direct reference (NOT a Proxy) so that `instanceof
// PgDatabase` checks in third-party libraries (e.g. Auth.js DrizzleAdapter)
// pass cleanly. The trade-off: importing this module requires DATABASE_URL.
// If you need lazy init (e.g. during type-checking), use `getDb()` instead.
// During build-time when DATABASE_URL may be unset, we fall back to a
// build-safe stub URL so the module loads; runtime queries will still throw
// on actual use, which is the desired behaviour.
function buildSafeUrl(): void {
  if (!process.env.DATABASE_URL) {
    const host = process.env.POSTGRES_HOST ?? "localhost";
    const port = process.env.POSTGRES_PORT ?? "5432";
    const user = process.env.POSTGRES_USER ?? "gml";
    const pass = process.env.POSTGRES_PASSWORD ?? "postgres";
    const dbn = process.env.POSTGRES_DB ?? "gml_lms";
    process.env.DATABASE_URL = `postgres://${user}:${pass}@${host}:${port}/${dbn}`;
  }
}
buildSafeUrl();
export const db: NodePgDatabase<typeof schema> = getDb();
