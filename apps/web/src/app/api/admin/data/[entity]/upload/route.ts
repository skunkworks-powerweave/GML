// POST /api/admin/data/[entity]/upload?field=<field> -- a PDF for a form field
// that declares `upload: "pdf"` (resources.fileKey; admin/types.ts). Multipart
// with one `file`. Stores it in the `pdfs` bucket the PDF viewer reads
// (admin/pdf-upload.ts) and answers the key; the grid's form puts the key in
// the field, and the row is written by the ordinary create or update, which
// is where it is validated and audited as admin.row.*. The upload itself is
// audited as resource.pdf.uploaded.
//
// A route handler, not a server action: an action's body is capped at 1 MB.
// Answers JSON codes, which the form says in the user's language
// (adminData.client.pdfUpload.errors): 201 { fileKey, bytes }, or
// { error } with 400 / 401 / 403 / 404 / 413 / 422 / 502.

import { NextResponse } from "next/server";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { entityGateOpen } from "@/admin/access";
import { checkPdf, PDF_MAX_BODY_BYTES, PDF_MAX_BYTES, storePdf } from "@/admin/pdf-upload";
import { requireApiRole } from "@/lib/api-guards";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

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

/** A browser POST from another site carries an Origin that is not ours. */
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

const tooLarge = () =>
  NextResponse.json({ error: "too_large", maxBytes: PDF_MAX_BYTES }, { status: 413 });

export async function POST(req: Request, ctx: { params: Promise<{ entity: string }> }) {
  const { entity: slug } = await ctx.params;
  const entity = Object.prototype.hasOwnProperty.call(ADMIN_ENTITIES, slug) ? ADMIN_ENTITIES[slug] : undefined;

  // Whoever may write the entity's rows, and nobody for an unknown one --
  // checked before the slug is looked at further, as the CSV routes do.
  const gate = await requireApiRole(entity ? (entity.mutateRoles ?? entity.readRoles) : []);
  if (gate.response) return gate.response;

  // Only a field that is an upload: nothing else may put objects in the bucket.
  const field = new URL(req.url).searchParams.get("field") ?? "";
  if (!entity || entity.fields?.[field]?.upload !== "pdf" || !entity.formFields.includes(field)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!(await entityGateOpen(entity, gate.session.user.id))) {
    return NextResponse.json({ error: "gate_required", gate: entity.gate }, { status: 403 });
  }
  if (!sameOrigin(req)) return NextResponse.json({ error: "cross_origin" }, { status: 403 });

  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > PDF_MAX_BODY_BYTES) return tooLarge();
  const body = await readCapped(req, PDF_MAX_BODY_BYTES);
  if (!body) return tooLarge();

  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return NextResponse.json({ error: "bad_form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const refusal = checkPdf(bytes);
  if (refusal) {
    const status = refusal === "no_file" ? 400 : refusal === "too_large" ? 413 : 422;
    return NextResponse.json({ error: refusal, ...(refusal === "too_large" ? { maxBytes: PDF_MAX_BYTES } : {}) }, { status });
  }

  let fileKey: string;
  try {
    fileKey = await storePdf(bytes, entity.slug);
  } catch (err) {
    console.error("[admin.upload] storage refused the PDF", err);
    return NextResponse.json({ error: "storage" }, { status: 502 });
  }

  await recordAudit({
    action: "resource.pdf.uploaded",
    entityType: "resource",
    metadata: { fileKey, bytes: bytes.byteLength, field },
  });
  return NextResponse.json({ fileKey, bytes: bytes.byteLength }, { status: 201 });
}
