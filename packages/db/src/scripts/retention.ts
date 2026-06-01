// SM-8 retention: delete notifications older than 90 days.
// Wired to a daily BullMQ scheduled job in spec 039. For now, callable via:
//   pnpm --filter @gml/db retention
// IT can also schedule it via host cron until the worker is live.

import "dotenv/config";
import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { notifications } from "../src/schema/notifications";

const RETAIN_DAYS = 90;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000);
  const result = await db.delete(notifications).where(lt(notifications.createdAt, cutoff));
  console.log(`[SM-8] deleted notifications older than ${cutoff.toISOString()}: ${result.rowCount ?? "?"} rows`);
  await pool.end();
}

main().catch((err) => {
  console.error("[SM-8 retention] failed:", err);
  process.exit(1);
});
