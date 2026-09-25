// Run Drizzle migrations against DATABASE_URL, then apply any raw SQL in
// `src/migrations/_post/` (substrate-moat REVOKE/trigger statements, partition
// management, RLS, etc. that drizzle-kit can't generate).

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { poolConfig } from "../src/client.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function applyPostMigrations(pool: Pool): Promise<void> {
  const postDir = resolve(__dirname, "..", "src", "migrations", "_post");
  if (!existsSync(postDir)) {
    console.log("[migrate] no _post directory; skipping raw SQL phase.");
    return;
  }
  const files = readdirSync(postDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    console.log("[migrate] _post directory empty; skipping raw SQL phase.");
    return;
  }
  // Create the bookkeeping table once.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _post_migrations_applied (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  for (const file of files) {
    const { rows } = await pool.query(
      "SELECT 1 FROM _post_migrations_applied WHERE filename = $1",
      [file],
    );
    if (rows.length > 0) {
      console.log(`[migrate] _post/${file} already applied — skipping.`);
      continue;
    }
    const sql = readFileSync(join(postDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _post_migrations_applied(filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[migrate] applied _post/${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] FAILED _post/${file}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Apply `_post/always/*.sql` on EVERY run, after the ledgered _post files and
 * without a ledger entry.
 *
 * The ledgered lane is right for one-off changes and wrong for an invariant
 * over "every table": a file that loops over the tables that exist when it
 * runs never sees a table a later migration creates. _post/002's RLS lockdown
 * was exactly that, so tables added after it (jobs, rate_limits,
 * quiz_attempts, and every one to come) kept RLS off on any database it had
 * already run on. Files here must be idempotent and must touch nothing once
 * the invariant holds -- a deploy runs while the previous app is serving.
 */
async function applyEveryDeploySql(pool: Pool): Promise<void> {
  const alwaysDir = resolve(__dirname, "..", "src", "migrations", "_post", "always");
  if (!existsSync(alwaysDir)) return;
  const files = readdirSync(alwaysDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(alwaysDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      console.log(`[migrate] ran _post/always/${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] FAILED _post/always/${file}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set. Aborting.");
    process.exit(1);
  }
  // TLS exactly as the app's own pool negotiates it. This was a bare
  // `new Pool({ connectionString: url })`: with the documented DATABASE_URL
  // (no sslmode) every DDL statement, run as the owner role, went to the
  // pooler in plaintext, and the CA mounted into this container was never read.
  const pool = new Pool(poolConfig());
  const db = drizzle(pool);
  const migrationsFolder = resolve(__dirname, "..", "src", "migrations");
  console.log(`[migrate] applying drizzle migrations from ${migrationsFolder} ...`);
  await migrate(db, { migrationsFolder });
  console.log("[migrate] drizzle migrations done; applying _post SQL ...");
  await applyPostMigrations(pool);
  await applyEveryDeploySql(pool);
  console.log("[migrate] all done.");
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
