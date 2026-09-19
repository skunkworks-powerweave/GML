// Audit-log helpers. Use recordAudit() for ad-hoc events; wrap server actions
// with withAudit() to get automatic before/after logging.

import "server-only";
import { headers } from "next/headers";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { auditLog, type AuditAction } from "@gml/db/schema";
import { auth } from "@/auth";

export type AuditInput = {
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  // Override-channel — used by code paths that already know who the actor is
  // (e.g. login flow that has not yet established a session) or that run
  // outside a request scope and so cannot call `auth()` / `headers()`.
  // Both fields are optional; if absent we fall back to the request scope.
  userId?: string;
  ipOverride?: string;
};

// Spec 167 — process-local degraded-mode counter for the audit channel.
//
// Spec 141 made `recordAudit` return `Promise<boolean>` so callers can react
// to a failed insert. High-stakes callers (gate rotation, bulk PII exports,
// password reset writes) check the boolean and, on `false`, both `console.error`
// AND increment this counter via `noteAuditDegraded()`. The counter is a
// simple in-memory tally read by `getAuditDegradedCount()` — useful for an
// admin diagnostic surface or a future Prometheus exporter. It MUST NOT
// block the originating business flow: audit-failure is a logging concern,
// not a business-rule concern, and an outage that takes audit down should
// not also take rotation / exports / password resets down.
//
// The counter is process-local on purpose. We don't reach for Redis here
// because the failure mode this counter detects (DB down for inserts) is
// exactly the kind of outage that would also take a shared counter offline.
// A per-process tally lets each web container report its own degraded count
// even when half the cluster has lost backend connectivity.
let auditDegradedCount = 0;

export function noteAuditDegraded(callsite: string): void {
  auditDegradedCount += 1;
  console.error(
    `[audit] degraded-mode write at ${callsite} — recordAudit returned false (count=${auditDegradedCount})`,
  );
}

export function getAuditDegradedCount(): number {
  return auditDegradedCount;
}

// Test-only reset hook. Exported so the spec-167 governance / integration
// tests can isolate the counter between runs without exposing a setter to
// production callers.
export function __resetAuditDegradedCountForTests(): void {
  auditDegradedCount = 0;
}

/**
 * Insert one audit row. Returns `true` if the row was committed, `false` if
 * the insert blew up (DB down, schema mismatch, network partition).
 *
 * Spec 141 (auth-fail-closed-and-gate-audit): the contract changed from
 * `Promise<void>` to `Promise<boolean>` so high-risk callers (auth, gate
 * verification) can detect a degraded audit channel and refuse to proceed
 * silently. Existing `void recordAudit(...)` callers stay correct — they
 * just discard the new boolean.
 */
/**
 * Reduce an IP to its network prefix.
 *
 * IPv4 keeps the first three octets (the /24); IPv6 keeps the first four
 * hextets (the /64, the standard end-site allocation boundary). That is enough
 * to tell "this came from many places" from "this came from one", and not
 * enough to identify a household.
 *
 *   203.0.113.42      -> 203.0.113.x
 *   2001:db8:1::abcd  -> 2001:db8:1:0:x
 */
export function maskIp(ip: string | undefined): string | undefined {
  if (!ip || ip === "unknown") return ip;
  if (ip.includes(":")) {
    // Expand the :: shorthand before slicing, or 2001:db8::1 and
    // 2001:db8:0:0:0:0:0:1 would mask to different prefixes.
    const [head, tail] = ip.split("::", 2);
    let parts: string[];
    if (tail === undefined) {
      parts = head!.split(":");
    } else {
      const h = head ? head.split(":") : [];
      const t = tail ? tail.split(":") : [];
      parts = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    }
    return parts.slice(0, 4).join(":") + ":x";
  }
  const octets = ip.split(".");
  if (octets.length === 4) return octets.slice(0, 3).join(".") + ".x";
  return "masked";
}

export async function recordAudit(input: AuditInput): Promise<boolean> {
  try {
    let userId = input.userId;
    let ip: string | undefined = input.ipOverride;
    let ua: string | undefined;
    // `auth()` / `headers()` only work inside a request scope. The login
    // flow's rate-limit-down branch already has the IP in hand; if either
    // helper throws (no request scope) we treat that as a soft miss and
    // still try to persist what we have.
    try {
      if (!userId) {
        const session = await auth();
        userId = session?.user?.id;
      }
    } catch {
      // No session context available — proceed without userId.
    }
    try {
      const hdr = await headers();
      if (!ip) {
        ip =
          hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          hdr.get("x-real-ip") ??
          undefined;
      }
      ua = hdr.get("user-agent") ?? undefined;
    } catch {
      // No request headers (e.g. background job) — proceed without them.
    }

    // MASK BEFORE WRITING. Migration 0020 documented audit_log.ip as holding
    // "the MASKED requesting IP (last octet stripped, same shape as audit.ip —
    // see auth.ts maskIp)". BOTH halves of that were false: audit.ip held the
    // RAW address, and `maskIp` did not exist anywhere in the codebase. The
    // masking was described in a migration comment, cited by other comments,
    // and implemented by nothing.
    //
    // It matters because this column is read by every administrator through
    // /admin/audit. A raw address plus a timestamp is a per-user location
    // history of staff and, through the learner surfaces, of visits to
    // particular schools. The masked form still distinguishes "many sources"
    // from "one source", which is what an investigation actually needs.
    ip = maskIp(ip);
    await db.insert(auditLog).values({
      userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ip,
      userAgent: ua,
      metadata: input.metadata ?? {},
    });
    return true;
  } catch (err) {
    // Best-effort: never throw out of recordAudit. The boolean return lets the
    // caller decide whether to fail-closed when the audit channel is degraded.
    console.error("[audit] failed to insert", err);
    return false;
  }
}

/**
 * Spec 168 — deduplicated audit insert.
 *
 * Some surfaces (the /repo/students name-search bar; future high-traffic
 * read surfaces) want an audit trail for every search query but cannot
 * afford to write one row per render — a user typing a long word four
 * characters at a time produces four near-identical audit rows, and the
 * SM-9 audit log floods. This helper collapses near-duplicates by
 * checking `audit_log` for an existing matching row in the last
 * `ttlSeconds` seconds (matched by action + userId + the dedupKey held
 * in `metadata.__dedupKey`) and SKIPS the INSERT when one is found.
 *
 * The dedupKey is stored on a reserved metadata field (`__dedupKey`) so
 * callers can still attach their own metadata payload — the dedup logic
 * never collides with the caller's keyspace. The check itself is NOT
 * atomic: a tight burst of identical requests can each see "no match"
 * and each insert their own row. A few duplicates per hour is fine —
 * the goal is "no more 600 rows / minute", not "exactly one row per
 * (user × key × hour)".
 *
 * Returns:
 *   `true`  → a new row was inserted
 *   `false` → a matching recent row existed; insert was skipped
 *
 * On any DB error (SELECT fails, INSERT fails), the helper falls back to
 * the same fail-closed shape as `recordAudit` and returns `false` — the
 * caller can treat that as "no-op happened" without leaking a stack
 * trace into the request scope.
 */
export type AuditDedupInput = AuditInput & {
  /** Stable key that identifies the "same" event for dedup purposes.
   *  e.g. `q=mary|user=abc` collapses every search for "mary" by user abc
   *  inside the TTL window into one audit row. */
  dedupKey: string;
  /** TTL window in seconds. A matching audit_log row created within the
   *  last `ttlSeconds` seconds suppresses a new insert. */
  ttlSeconds: number;
};

export async function recordAuditDedup(input: AuditDedupInput): Promise<boolean> {
  try {
    // Resolve userId / ip / ua the same way recordAudit does so the dedup
    // SELECT matches what a fresh INSERT would store. We need the userId
    // BEFORE the SELECT so the where clause can pin it.
    let userId = input.userId;
    let ip: string | undefined = input.ipOverride;
    let ua: string | undefined;
    try {
      if (!userId) {
        const session = await auth();
        userId = session?.user?.id;
      }
    } catch {
      // No session context available.
    }
    try {
      const hdr = await headers();
      if (!ip) {
        ip =
          hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          hdr.get("x-real-ip") ??
          undefined;
      }
      ua = hdr.get("user-agent") ?? undefined;
    } catch {
      // No request headers.
    }

    // Look for a matching row inside the TTL window. The dedup match is on
    // (action, userId, metadata.__dedupKey) — three predicates AND'd. We
    // use the jsonb ->> text accessor against `__dedupKey` since the
    // metadata column is jsonb. A null userId (anonymous request) becomes
    // an IS NULL match — same shape as recordAudit's storage.
    const sinceCutoff = new Date(Date.now() - input.ttlSeconds * 1000);
    const userIdPred = userId
      ? eq(auditLog.userId, userId)
      : sql`${auditLog.userId} IS NULL`;
    const existing = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, input.action),
          userIdPred,
          gte(auditLog.createdAt, sinceCutoff),
          sql`${auditLog.metadata} ->> '__dedupKey' = ${input.dedupKey}`,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Hit — skip the insert. Caller can ignore the return value if all
      // it wants is "best-effort audit".
      return false;
    }

    // Miss — insert a fresh row with the dedupKey stamped into metadata
    // under the reserved `__dedupKey` field. We merge the caller's
    // metadata so this stays opaque to the caller's other fields.
    const metadata = {
      ...(input.metadata ?? {}),
      __dedupKey: input.dedupKey,
    };
    await db.insert(auditLog).values({
      userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ip,
      userAgent: ua,
      metadata,
    });
    return true;
  } catch (err) {
    console.error("[audit] recordAuditDedup failed", err);
    return false;
  }
}

/**
 * Wrap a server action so it audit-logs on completion. Action errors are
 * re-thrown after the failure is logged.
 */
export function withAudit<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  meta: AuditInput,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    try {
      const result = await fn(...args);
      void recordAudit(meta);
      return result;
    } catch (err) {
      // A DISTINCT ACTION NAME, not the success one with an `error` key bolted
      // into metadata. The previous shape wrote the failure under
      // `admin.row.delete` — the same action as a real deletion — differing
      // only by a field buried in a JSON blob. So the append-only forensic log
      // recorded deletions that never happened, and an operator scanning the
      // action column could not tell them apart.
      void recordAudit({
        ...meta,
        action: `${meta.action}.failed`,
        metadata: { ...(meta.metadata ?? {}), error: String(err).slice(0, 500) },
      });
      throw err;
    }
  };
}
