// POST /api/scorm/packages -- upload a SCORM 1.2 package (multipart: file,
// rttSubjectId, optional title). SUPER_ADMIN ONLY; lib/scorm/ingest.ts says
// why, and does the validation and storing.
//
// A route handler, not a server action, because of size: a server action's
// body is capped at 1 MB, and proxy.ts -- which runs on every page route --
// buffers at most 10 MB of a body and silently passes on the TRUNCATED rest.
// proxy.ts's matcher therefore excludes this path; auth() here refreshes the
// session itself. The cap that does apply is SCORM_LIMITS.maxPackageBytes,
// under Caddy's 25 MB request_body limit.
//
// Answers JSON, for ./admin/scorm/upload-form.tsx: 201 { id, ... }, or
// { error: { code, message, paths? } } with 400 / 403 / 413 / 422 / 502.

import { NextResponse } from "next/server";
import { db } from "@gml/db";
import { requireApiRole } from "@/lib/api-guards";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { ingestPackage } from "@/lib/scorm/ingest";
import { SCORM_LIMITS } from "@/lib/scorm/package";

export const dynamic = "force-dynamic";

/** The package plus the multipart framing and the two small fields. */
const MAX_BODY_BYTES = SCORM_LIMITS.maxPackageBytes + 256 * 1024;

const refuse = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status });

const TOO_LARGE = () => refuse(413, "too_large", `A package can be at most ${SCORM_LIMITS.maxPackageBytes / 1024 / 1024} MB.`);

/** The body, or null once it passes `max` bytes (reading stops there). */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * A browser POST from another site carries an Origin that is not ours. The
 * session cookie is SameSite=Lax, so it would not be sent on one anyway; this
 * does not rely on that.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const gate = await requireApiRole(["super_admin"]);
  if (gate.response) return gate.response;
  if (!sameOrigin(req)) return refuse(403, "cross_origin", "Uploads must come from this site.");

  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return TOO_LARGE();
  const body = await readCapped(req, MAX_BODY_BYTES);
  if (!body) return TOO_LARGE();

  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return refuse(400, "bad_form", "The upload was not a form submission.");
  }
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return refuse(400, "no_file", "Choose a SCORM .zip to upload.");
  if (file.size > SCORM_LIMITS.maxPackageBytes) return TOO_LARGE();
  const rttSubjectId = String(form.get("rttSubjectId") ?? "");
  if (!isUuid(rttSubjectId)) return refuse(400, "no_subject", "Choose the RTT subject this package belongs to.");
  const title = String(form.get("title") ?? "").trim() || null;

  const result = await ingestPackage(db, {
    bytes: new Uint8Array(await file.arrayBuffer()),
    rttSubjectId,
    title,
    uploadedByUserId: gate.session.user.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await recordAudit({
    action: "scorm.package.upload",
    entityType: "scorm_package",
    entityId: result.id,
    metadata: { title: result.title, rttSubjectId, fileCount: result.fileCount, totalBytes: result.totalBytes },
  });
  return NextResponse.json(
    { id: result.id, title: result.title, fileCount: result.fileCount, totalBytes: result.totalBytes },
    { status: 201 },
  );
}
