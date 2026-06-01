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
//   - Body:    { resourceId: uuid, viewerId?: string }. Validated with zod.
//              Legacy alias: `{ id }` accepted as `resourceId` so the existing
//              PdfViewer caller (`body: JSON.stringify({ id: resourceId })`)
//              keeps working without a UI touch in this run.
//   - Effect:  recordAudit({ action: "resource.view.client_ping", ... }).
//   - Status:  204 on success, 400 on bad body, 401 on no session.
//   - NEVER 404: we deliberately do NOT verify the resource exists. This is
//              telemetry — never block a user-facing flow on a missing row.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

// Accept the spec contract (`resourceId`) and the legacy PdfViewer shape (`id`)
// — whichever lands, we normalise to `resourceId`. `viewerId` is optional
// extra metadata that the client may forward (e.g. the watermark identity).
const BodySchema = z
  .object({
    resourceId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
    viewerId: z.string().max(128).optional(),
  })
  .refine((v) => Boolean(v.resourceId ?? v.id), {
    message: "resourceId is required",
    path: ["resourceId"],
  });

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
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
    metadata: {
      beacon: true,
      viewerId: parsed.data.viewerId ?? session.user.id,
    },
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
