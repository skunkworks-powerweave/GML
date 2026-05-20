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
};

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const session = await auth();
    const hdr = await headers();
    const ip =
      hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      hdr.get("x-real-ip") ??
      undefined;
    const ua = hdr.get("user-agent") ?? undefined;
    await db.insert(auditLog).values({
      userId: session?.user?.id,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ip,
      userAgent: ua,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    // Best-effort: never fail the user-facing flow because audit insert blew up.
    console.error("[audit] failed to insert", err);
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
