// Nightly retention sweep.
//
//   SM-8          notifications older than 90 days are deleted.
//   rate_limits   counters whose window started more than 24 hours ago are
//                 deleted (see pruneRateLimits below).
//   section_gate_grants
//                 grants that expired more than 24 hours ago are deleted (see
//                 pruneExpiredGateGrants below).
//
// The worker runs all three, once a day, from the job scheduleDailyWork() enqueues
// (apps/worker/src/index.ts, the `deleteOldNotifications` arm of the job
// switch; spec 107). The script is still directly runnable for ad-hoc IT use:
//   pnpm --filter @gml/db retention

import "dotenv/config";
import { lt, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDb, getPool } from "../client.js";
import { notifications } from "../schema/notifications";
import { rateLimits } from "../schema/rateLimits";
import { sectionGateGrants } from "../schema/gates";

const RETAIN_DAYS = 90;

/**
 * How long a rate-limit counter is kept after its window started.
 *
 * The longest window any caller configures is 15 minutes, so 24 hours is
 * conservative by two orders of magnitude -- and deleting a row whose window
 * has passed is harmless in any case: the next request from that caller simply
 * starts a fresh window, exactly as the upsert in rateLimit() would have.
 */
const RATE_LIMIT_RETAIN_HOURS = 24;

/**
 * Delete notifications older than RETAIN_DAYS (90) days. Returns the number
 * of rows deleted. Callable both from the direct CLI entry point and from the
 * worker's retention job (spec 107).
 *
 * It used to open and close a pool of its own, `new Pool({ connectionString })`,
 * which negotiated no TLS for the documented DATABASE_URL -- the one sibling of
 * pruneRateLimits (below) that still had the hazard its comment describes -- and
 * which, with Supabase's "Enforce SSL" on, failed every run before
 * pruneRateLimits was reached. It now takes the same shared handle, with the
 * same ownership rule: the worker keeps that pool, main() closes it.
 */
export async function deleteOldNotifications(
  db: Pick<NodePgDatabase<Record<string, unknown>>, "delete"> = getDb(),
): Promise<number> {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000);
  const result = await db.delete(notifications).where(lt(notifications.createdAt, cutoff));
  const rowCount = result.rowCount ?? 0;
  console.log(`[SM-8] deleted notifications older than ${cutoff.toISOString()}: ${rowCount} rows`);
  return rowCount;
}

/**
 * Delete rate-limit counters whose window started more than `olderThanHours`
 * ago. Returns the number of rows deleted.
 *
 * ── WHY THIS IS HERE ─────────────────────────────────────────────────────────
 *
 * It used to live in apps/web/src/lib/rate-limit.ts under a docstring saying
 * it was "called from the nightly retention job". It was called from nowhere,
 * and could not have been: that file begins `import "server-only"`, and the
 * worker that runs the nightly job has never imported from apps/web. So
 * rate_limits kept one permanent row per distinct caller -- and the keys are
 * IP-bearing (`login-link:<ip>`, `gate:<ip>:<userId>:<section>`), which made
 * the table an indefinite record of which address tried to sign in, as whom,
 * and when. It now sits on the side of the fence the worker can reach, and
 * the worker's nightly job calls it.
 *
 * ── WHICH CONNECTION ─────────────────────────────────────────────────────────
 *
 * Like deleteOldNotifications() this does not open a pool of its own. By
 * default it uses @gml/db's shared handle -- the same `db` the worker already
 * holds -- because that is the one client.ts configures TLS for; a bare
 * `new Pool({ connectionString })` would carry IP-bearing rows over whatever
 * the URL alone negotiates. Whoever owns that pool owns its lifetime: the
 * worker keeps it for the life of the process, main() below closes it.
 * `database` exists so a caller (a test) can hand in its own connection.
 */
export async function pruneRateLimits(
  olderThanHours: number = RATE_LIMIT_RETAIN_HOURS,
  database: Pick<NodePgDatabase<Record<string, unknown>>, "delete"> = getDb(),
): Promise<number> {
  const seconds = Math.max(0, Math.round(olderThanHours * 3600));
  // Compared against the DATABASE clock, like the upsert in rateLimit() that
  // wrote window_start, so app/database clock skew cannot shorten a window.
  const result = await database
    .delete(rateLimits)
    .where(sql`${rateLimits.windowStart} < now() - make_interval(secs => ${seconds})`);
  const rowCount = result.rowCount ?? 0;
  console.log(`[retention] deleted rate_limits counters older than ${olderThanHours}h: ${rowCount} rows`);
  return rowCount;
}

/** How long a section-gate grant is kept after it stopped authorising anything. */
const GATE_GRANT_RETAIN_HOURS_AFTER_EXPIRY = 24;

/**
 * Delete section-gate grants that expired more than `olderThanHours` ago.
 * Returns the number of rows deleted.
 *
 * Every gate unlock writes a grant carrying the user, the section, the unlock
 * time and the client IP, and the only other DELETE is rotation's delete-by-
 * slug. So a gate that is never rotated turned the table into a permanent log
 * of who unlocked which section from which address -- the same concern that
 * made rate_limits prunable. A grant authorises nothing once expires_at has
 * passed (at most 8 hours after issue, by CHECK); the day of grace only keeps
 * a recent one visible to an administrator looking into last night's access.
 *
 * Same connection rules as pruneRateLimits(): the shared @gml/db handle by
 * default, so it goes over the TLS client.ts configures.
 */
export async function pruneExpiredGateGrants(
  olderThanHours: number = GATE_GRANT_RETAIN_HOURS_AFTER_EXPIRY,
  database: Pick<NodePgDatabase<Record<string, unknown>>, "delete"> = getDb(),
): Promise<number> {
  const seconds = Math.max(0, Math.round(olderThanHours * 3600));
  const result = await database
    .delete(sectionGateGrants)
    .where(sql`${sectionGateGrants.expiresAt} < now() - make_interval(secs => ${seconds})`);
  const rowCount = result.rowCount ?? 0;
  console.log(`[retention] deleted section_gate_grants expired more than ${olderThanHours}h ago: ${rowCount} rows`);
  return rowCount;
}

export async function main(): Promise<void> {
  try {
    await deleteOldNotifications();
    await pruneRateLimits();
    await pruneExpiredGateGrants();
  } finally {
    // Both sweeps borrow the shared pool; without this the CLI lingers until
    // the pool's idle timeout instead of exiting.
    await getPool().end();
  }
}

// Entry-point guard: only auto-run when invoked directly (e.g. `tsx retention.ts`),
// not when imported by the worker or by tests.
//
// Spec 163 — Workflow Run 15 audit-closure NIT: the strict
// `import.meta.url === pathToFileURL(...)` equality works under normal
// invocation but is fragile under symlinks (a `pnpm` symlinked package
// can have a different absolute path on the two sides of the
// comparison even though they resolve to the same script). The
// fallback below compares the BASENAME of both paths so a symlinked
// script still auto-runs when invoked directly. This is intentionally
// a defensive net rather than the primary check — the strict equality
// remains first because it's the only one that catches a same-named
// script run from a different directory (which is the original guard's
// purpose).
function isDirectInvocation(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  // Primary: strict absolute-path equality (the original guard shape).
  if (import.meta.url === pathToFileURL(argvPath).href) return true;
  // Fallback: basename equality. Catches the symlink case (pnpm-linked
  // packages, container bind mounts, etc.) where the two paths point
  // at the same script but resolve to different absolute paths.
  try {
    const selfPath = fileURLToPath(import.meta.url);
    return basename(selfPath) === basename(argvPath);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    console.error("[SM-8 retention] failed:", err);
    process.exit(1);
  });
}
