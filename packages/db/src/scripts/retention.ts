// SM-8 retention: delete notifications older than 90 days.
// Wired to a daily BullMQ scheduled job in spec 107 (the worker registers a
// repeat job at cron '0 3 * * *' that calls deleteOldNotifications()). The
// script is still directly runnable for ad-hoc IT use:
//   pnpm --filter @gml/db retention

import "dotenv/config";
import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { notifications } from "../schema/notifications";

const RETAIN_DAYS = 90;

/**
 * Delete notifications older than RETAIN_DAYS (90) days. Returns the number
 * of rows deleted. Opens and closes its own pg.Pool — callable both from the
 * direct CLI entry point and from the BullMQ retention worker (spec 107).
 */
export async function deleteOldNotifications(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL not set");
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000);
  try {
    const result = await db.delete(notifications).where(lt(notifications.createdAt, cutoff));
    const rowCount = result.rowCount ?? 0;
    console.log(`[SM-8] deleted notifications older than ${cutoff.toISOString()}: ${rowCount} rows`);
    return rowCount;
  } finally {
    await pool.end();
  }
}

export async function main(): Promise<void> {
  await deleteOldNotifications();
}

// Entry-point guard: only auto-run when invoked directly (e.g. `tsx retention.ts`),
// not when imported by the worker or by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[SM-8 retention] failed:", err);
    process.exit(1);
  });
}
