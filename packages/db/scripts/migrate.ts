// Run Drizzle migrations against DATABASE_URL.
// Called from `pnpm --filter @gml/db migrate` and from the app container's entrypoint
// on first boot.

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set. Aborting.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  const migrationsFolder = resolve(__dirname, "..", "src", "migrations");
  console.log(`[migrate] applying from ${migrationsFolder} ...`);
  await migrate(db, { migrationsFolder });
  console.log("[migrate] done");
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
