// POST /api/audit/resource-view — client-side render-confirmation beacon for the
// PDF viewer. The PRIMARY audit (`resource.pdf.view`) is already written
// server-side in spec 087's `/repo/resource/[id]/view` page load. This route is a
// SECONDARY, fire-and-forget confirmation that the in-browser viewer actually
// painted on the user's screen — useful for distinguishing "server rendered but
// the iframe never loaded" from "user actually saw it" when investigating
// SM-9 audit trails.
//
// Contract (load-bearing — see test_099_api_audit_resource_view.test.mjs):
//   - Method:  POST only. GET returns 405.
//   - Auth:    requires session. 401 otherwise (best-effort beacons from
//              logged-out tabs are rejected, not silently logged).
//   - Body:    { resourceId: uuid }. Validated with zod.
//              Legacy alias: `{ id }` accepted as `resourceId` so the existing
//              PdfViewer caller (`body: JSON.stringify({ id: resourceId })`)
//              keeps working without a UI touch in this run.
//   - Effect:  recordAudit({ action: "resource.view.client_ping", ... }).
//   - Status:  204 on success; 400 { error: "invalid_json" } for a body that
//              is not JSON, 400 { error: "validation_failed", issues:
//              [{ path, message }] } for a bad one; 401 { error:
//              "unauthenticated" } on no session; 429 over the per-user
//              throttle.
//   - NEVER 404: we deliberately do NOT verify the resource exists. This is
//              telemetry — never block a user-facing flow on a missing row.
//
// THROTTLED, because that last point means any well-formed uuid is accepted,
// and each call is a permanent row in the append-only audit_log. With nothing
// in front of it, a script cycling random uuids wrote one row per request for
// as long as it ran. The client-audit beacon beside this route was limited
// for the same reason.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { publicIssues, readJsonBody } from "@/lib/api-json";
import { rateLimit } from "@/lib/rate-limit";

// Per user. PdfViewer pings once per document it paints, so this is far more
// PDFs a minute than a person opens.
const RESOURCE_VIEW_LIMIT = 30;
const RESOURCE_VIEW_WINDOW_MS = 60_000;

// Accept the spec contract (`resourceId`) and the legacy PdfViewer shape (`id`)
// — whichever lands, we normalise to `resourceId`.
//
// NO viewerId. The body used to take one and write it into the row as the
// viewer, so a forensic record of who saw a document named whoever the client
// claimed. The viewer is the session's user, which recordAudit already stores
// as the row's user_id. A client still sending viewerId is not refused: zod
// drops the unknown key.
const BodySchema = z
  .object({
    resourceId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.resourceId ?? v.id), {
    message: "resourceId is required",
    path: ["resourceId"],
  });

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Fail closed (lib/rate-limit.ts): an unthrottled beacon is the defect this
  // guards against, and a dropped ping blocks nothing -- PdfViewer ignores the
  // response.
  try {
    const rl = await rateLimit({
      bucket: "resource-view",
      id: session.user.id,
      limit: RESOURCE_VIEW_LIMIT,
      windowMs: RESOURCE_VIEW_WINDOW_MS,
    });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: rl.retryAfterMs },
        { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))) } },
      );
    }
  } catch {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }

  const read = await readJsonBody(req);
  if (read.response) return read.response;
  const parsed = BodySchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: publicIssues(parsed.error) },
      { status: 400 },
    );
  }
  const resourceId = (parsed.data.resourceId ?? parsed.data.id) as string;

  // SM-9 secondary signal. `recordAudit` already swallows insert errors so a
  // dead audit_log table can never bring the beacon endpoint down.
  void recordAudit({
    action: "resource.view.client_ping",
    entityType: "resource",
    entityId: resourceId,
    metadata: { beacon: true },
  });

  return new NextResponse(null, { status: 204 });
}

// Explicit 405 for GET so probes / misconfigured clients get a clear answer
// instead of Next's default "method not allowed" HTML page.
export async function GET(): Promise<Response> {
  return NextResponse.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
