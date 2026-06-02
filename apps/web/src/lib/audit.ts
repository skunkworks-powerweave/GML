// Audit-log helpers. Use recordAudit() for ad-hoc events; wrap server actions
// with withAudit() to get automatic before/after logging.

import "server-only";
import { headers } from "next/headers";
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
      void recordAudit({
        ...meta,
        metadata: { ...(meta.metadata ?? {}), error: String(err) },
      });
      throw err;
    }
  };
}
