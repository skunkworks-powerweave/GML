// POST /api/scorm/attempts/<package id> -- the SCORM runtime's LMSCommit and
// LMSFinish (lib/scorm/runtime.ts, sent by the player page).
//
// Every commit carries the SCO's whole persisted state, so the route is
// idempotent and a lost commit is repaired by the next. Nothing in the body
// is trusted:
//   - the learner is the signed-in user; a user id in the body is ignored;
//   - JSON only. A cross-site <form> can POST text/plain or form data with
//     the session cookie attached; it cannot send application/json without a
//     CORS preflight, which this route never answers;
//   - bounded, then validated field by field (lib/scorm/cmi.ts) -- a learner
//     can call window.API from the console, and the record is self-reported
//     exactly as SCORM 1.2 defines it;
//   - only a package the learner may launch (lib/scorm/store.ts) accepts one.
//
// Audited on LMSFinish only: a session commits many times, and the finish is
// the event staff read the record for (SM-1: attributable).

import { NextResponse } from "next/server";
import { db } from "@gml/db";
import { requireApiSession } from "@/lib/api-guards";
import { readJsonBody } from "@/lib/api-json";
import { recordAudit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { parseCommitPayload } from "@/lib/scorm/cmi";
import { commitAttempt, packageForViewer } from "@/lib/scorm/store";

export const dynamic = "force-dynamic";

/** suspend_data is 4096 characters; three bytes each, plus the rest, is well under this. */
const MAX_BODY_BYTES = 16 * 1024;
const FINISH_AUDIT_LIMIT = 20;

/** Under the per-learner finish-audit limit? A limiter fault skips the row, not the commit. */
async function finishAuditAllowed(userId: string): Promise<boolean> {
  try {
    return (await rateLimit({ bucket: "scorm-finish", id: userId, limit: FINISH_AUDIT_LIMIT, windowMs: 60_000 })).ok;
  } catch {
    return false;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireApiSession();
  if (gate.response) return gate.response;
  const viewer = { id: gate.session.user.id, role: gate.session.user.role };

  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "json_required" }, { status: 415 });
  }
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }
  const read = await readJsonBody(req);
  if (read.response) return read.response;
  if (JSON.stringify(read.body).length > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const payload = parseCommitPayload(read.body);
  if (!payload) return NextResponse.json({ error: "invalid_commit" }, { status: 400 });

  const { id } = await params;
  const pkg = await packageForViewer(db, viewer, id);
  if (!pkg) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const newer = await commitAttempt(db, viewer.id, pkg.id, payload);

  // LMSFinish is audited once: not when a player re-sends a final whose
  // response was lost (not newer), and not past FINISH_AUDIT_LIMIT a minute --
  // the audit_log is permanent and this endpoint is any learner's (FR-19).
  // The commit itself is never refused.
  if ((read.body as { final?: unknown }).final === true && newer && (await finishAuditAllowed(viewer.id))) {
    await recordAudit({
      action: "scorm.attempt.finish",
      entityType: "scorm_package",
      entityId: pkg.id,
      userId: viewer.id,
      metadata: { lessonStatus: payload.lessonStatus, scoreRaw: payload.scoreRaw, sessionTimeCs: payload.sessionTimeCs },
    });
  }
  return NextResponse.json({ ok: true });
}
