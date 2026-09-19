// POST /api/videos/[id]/event — playback telemetry for the SM-1 audit trail.
//
// HlsPlayer has posted here on every play, pause and ended since it was
// written, and THIS ROUTE DID NOT EXIST -- there was no /api/videos directory
// at all. Every one of those beacons 404'd, silently, because the caller
// swallows rejections. So the `video.play` / `video.pause` audit rows that the
// player's own comment claims the server records have never been written, and
// the audit trail for the most sensitive artefact in the product -- classroom
// recordings of identifiable children -- had a hole exactly where "who watched
// this, and when" should be.
//
// Contract:
//   - Method   POST only.
//   - Auth     Requires a session. 401 otherwise.
//   - Access   assertCanAccessVideo. A play event is a claim about a specific
//              video, and accepting it from someone who may not watch that
//              video would poison the trail with rows that assert the opposite
//              of what the authorization layer enforces.
//   - Body     { kind: "play" | "pause" | "ended", t?: number }.
//   - Status   204 on success, 400 on a bad body, 401 unauthenticated.
//              assertCanAccessVideo answers 404 for an inaccessible id, which
//              is deliberate -- see lib/authz.ts on not confirming existence.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { actorFrom, assertCanAccessVideo } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

const BodySchema = z.object({
  kind: z.enum(["play", "pause", "ended"]),
  // Playback position in seconds. Bounded because it arrives from the client
  // and lands in the append-only audit table, which the application role
  // cannot delete from afterwards.
  t: z.number().finite().min(0).max(86_400).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;

  // A non-uuid id would otherwise reach Postgres as a uuid comparison and
  // throw 22P02. Checked here so a malformed URL is a 400, not a 500.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Throws notFound() when this viewer has no business with this video.
  await assertCanAccessVideo(actor, id);

  // Awaited, not void-ed: this endpoint exists ONLY to write this row, so a
  // failure to write it is a failure of the request, not a background detail.
  await recordAudit({
    action: `video.${parsed.data.kind}`,
    entityType: "video_submission",
    entityId: id,
    metadata: { positionSec: parsed.data.t ?? 0 },
  });

  return new NextResponse(null, { status: 204 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
