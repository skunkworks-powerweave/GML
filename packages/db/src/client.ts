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
