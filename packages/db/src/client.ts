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
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    return real[prop];
  },
});
