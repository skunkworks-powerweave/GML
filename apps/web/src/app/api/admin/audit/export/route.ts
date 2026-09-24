// GET /api/admin/audit/export — CSV export of the audit_log table.
//
// Frontend parity (spec 116): wires the "Export" button on
// /admin/audit (see LMS GML Frontend/admin.jsx::AuditLog line 252) to a real
// download endpoint. The button on /admin/audit links to this route with the
// same query string the page's filter form submitted, so the user gets the
// CSV view of exactly what they were browsing on screen.
//
// Method matrix:
//   GET                            → 200 text/csv   success
//   GET (no session)               → 401 unauthenticated
//   GET (role not in allow-list)   → 403 forbidden
//   GET (no admin section grant)   → 403 gate_required  (and an audit row)
//   GET (>10k rows match)          → 413 too_many_rows  (with narrowing hint)
//   POST                           → 405 method_not_allowed
//
// Filter semantics — mirror the admin/audit page query params plus a
// documented superset for narrower exports:
//   ?action       exact-match on audit_log.action (matches the page)
//   ?user         alias of ?userId — exact-match on audit_log.user_id (matches the page)
//   ?userId       exact-match on audit_log.user_id (canonical name)
//   ?entityType   exact-match on audit_log.entity_type
//   ?from         ISO timestamp; audit_log.created_at >= from
//   ?to           ISO timestamp; audit_log.created_at <  to
//
// CSV columns: timestamp, action, actor_user_id, entity_type, entity_id, ip,
// user_agent, metadata (metadata is JSON-stringified).
//
// Audit hook: this endpoint records its OWN call as
//   action="audit.bulk_export", entityType="audit_log",
//   metadata={ rowCount, filters: { action, userId, entityType, from, to } }
// so a downstream reviewer can see who exfiltrated which slice of the log.
// A request refused by the admin section gate records
// action="audit.bulk_export.gate_denied" instead -- a distinct action, never
// the success one, so the append-only log cannot show an export that did not
// happen.
//
// Hard cap: 10000 rows per request. If the selected count would exceed that,
// we return 413 with a JSON body hinting the caller to narrow by from/to or
// action. We measure the count cheaply via a `LIMIT cap+1` probe — if the
// probe returns cap+1 rows we know there's at least one more, so we 413
// rather than truncating silently (silent truncation is its own audit
// hazard).
//
// Imports use the locked workspace packages — no new deps. `papaparse` is
// already in apps/web/package.json (used by spec 098 + admin CSV importers).

import { NextResponse } from "next/server";
import Papa from "papaparse";
import { and, desc, gte, lt, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { auditLog } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit, noteAuditDegraded } from "@/lib/audit";
import { getActiveGrant } from "@/lib/gates";
import { hasAnyRole, type RoleName } from "@gml/shared/auth/roles";

/** Same shape /admin/audit validates against, kept in step deliberately. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

const ALLOWED_ROLES: RoleName[] = ["super_admin", "programme_admin"];
const ROW_CAP = 10000;

export async function GET(req: Request) {
  // Auth gate — API route returns JSON 401 rather than redirecting.
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Role gate — matches the /admin/audit page (requireRole) plus the /admin
  // middleware role list. super_admin + programme_admin only.
  if (!hasAnyRole(session.user.role, ALLOWED_ROLES)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Section gate. The PAGE these rows come from is gated
  // (admin/audit/layout.tsx, assertSectionGate) because "a role check alone is a
  // thinner guard than the UI was claiming". This endpoint streams the SAME
  // rows -- up to 10k, with ip, user agent and full metadata -- and checked the
  // role only, so an admin session that had never entered the admin section
  // password (a borrowed laptop in a shared school office is the realistic
  // case) could pull the whole log, and rotating that password closed nothing.
  //
  // getActiveGrant rather than assertSectionGate: the latter redirect()s, which
  // in a Route Handler is a 307 to an HTML unlock page where the method matrix
  // above promises JSON status codes. The only legitimate caller is the Export
  // CSV link on the gated page, whose user already holds a grant.
  //
  // BEFORE any row is read and before the audit.bulk_export row below: a denied
  // request must not record an export that did not happen. It records its own
  // action instead -- an ungranted admin probing this URL is exactly the signal
  // the gate exists to surface, and it used to leave no trace at all.
  const grant = await getActiveGrant(session.user.id, "admin");
  if (!grant) {
    const denialAudited = await recordAudit({
      action: "audit.bulk_export.gate_denied",
      entityType: "audit_log",
      metadata: { gateSlug: "admin", reason: "no_active_grant" },
    });
    if (!denialAudited) {
      noteAuditDegraded("/api/admin/audit/export (gate_denied)");
    }
    return NextResponse.json({ error: "gate_required" }, { status: 403 });
  }

  const url = new URL(req.url);
  const actionParam = url.searchParams.get("action") ?? undefined;
  // Page uses ?user; canonical name is ?userId — accept both.
  const userIdParam =
    url.searchParams.get("userId") ?? url.searchParams.get("user") ?? undefined;
  const entityTypeParam = url.searchParams.get("entityType") ?? undefined;
  const fromParam = url.searchParams.get("from") ?? undefined;
  const toParam = url.searchParams.get("to") ?? undefined;

  // Build filter expression — same semantics the admin/audit page uses, plus
  // the documented entityType/from/to superset.
  const filters = [] as ReturnType<typeof sql>[];
  if (actionParam) filters.push(sql`${auditLog.action} = ${actionParam}`);
  // Validated, exactly as /admin/audit validates it. This is a SEPARATE entry
  // point -- reachable directly, not only through that page's export button --
  // and an unparseable id bound against a uuid column is a 22P02 from the
  // driver, i.e. a 500 on the forensic export. An unparseable filter is a
  // filter that matches nothing, not an error.
  if (userIdParam) {
    if (!UUID_RE.test(userIdParam)) {
      return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
    }
    filters.push(sql`${auditLog.userId} = ${userIdParam}`);
  }
  if (entityTypeParam) filters.push(sql`${auditLog.entityType} = ${entityTypeParam}`);
  if (fromParam) {
    const from = new Date(fromParam);
    if (!Number.isNaN(from.getTime())) filters.push(gte(auditLog.createdAt, from));
  }
  if (toParam) {
    const to = new Date(toParam);
    if (!Number.isNaN(to.getTime())) filters.push(lt(auditLog.createdAt, to));
  }
  const whereExpr =
    filters.length === 0 ? sql`true` : and(...filters);

  // 10k row cap — probe with LIMIT cap+1 to detect overflow without an extra
  // COUNT(*) round-trip. If we see cap+1 rows we 413 with a hint.
  const rows = await db
    .select({
      id: auditLog.id,
      userId: auditLog.userId,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      ip: auditLog.ip,
      userAgent: auditLog.userAgent,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(whereExpr)
    .orderBy(desc(auditLog.createdAt))
    .limit(ROW_CAP + 1);

  if (rows.length > ROW_CAP) {
    return NextResponse.json(
      {
        error: "too_many_rows",
        cap: ROW_CAP,
        hint: "Narrow the export with ?from=, ?to=, ?action=, or ?userId=.",
      },
      { status: 413 },
    );
  }

  // Spec 167 — HIGH-STAKES audit. Recursively meta: exporting the audit log
  // itself is a privileged operation whose own audit row is the only record
  // anyone can use to detect that someone read the audit log. If the insert
  // fails we noteAuditDegraded() (logs the miss + bumps the process counter)
  // but still return the CSV — failing the response would leave the operator
  // with no exfiltrated data and a one-line stderr message, which is worse
  // than the captured-degraded state we're flagging.
  const auditOk = await recordAudit({
    action: "audit.bulk_export",
    entityType: "audit_log",
    metadata: {
      rowCount: rows.length,
      filters: {
        action: actionParam ?? null,
        userId: userIdParam ?? null,
        entityType: entityTypeParam ?? null,
        from: fromParam ?? null,
        to: toParam ?? null,
      },
    },
  });
  if (!auditOk) {
    noteAuditDegraded("/api/admin/audit/export");
  }

  // Shape rows into the documented CSV columns. JSON metadata is stringified
  // so it survives the flat CSV cell.
  const data = rows.map((r) => ({
    timestamp: r.createdAt ? r.createdAt.toISOString() : "",
    action: r.action,
    actor_user_id: r.userId ?? "",
    entity_type: r.entityType ?? "",
    entity_id: r.entityId ?? "",
    ip: r.ip ?? "",
    user_agent: r.userAgent ?? "",
    metadata: r.metadata ? JSON.stringify(r.metadata) : "",
  }));

  const fields = [
    "timestamp",
    "action",
    "actor_user_id",
    "entity_type",
    "entity_id",
    "ip",
    "user_agent",
    "metadata",
  ];
  const csv = Papa.unparse({ fields, data });

  // YYYYMMDD in UTC — strip dashes from the ISO date prefix.
  const filename = `audit-log-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function POST() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
