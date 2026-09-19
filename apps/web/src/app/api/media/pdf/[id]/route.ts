// Reading-material PDF, streamed to an authenticated viewer.
//
// PDFs are PROXIED rather than redirected to a signed URL, which is the
// opposite of the choice made for video segments. The reasoning is size and
// leakage, not consistency:
//
//   * A PDF is one request of a few megabytes, not two hundred requests of
//     hundreds of megabytes. Proxying it costs the server almost nothing,
//     whereas proxying video was the thing that made EC2 sizing hard.
//   * A redirect puts a working, shareable URL in the address bar, browser
//     history and any Referer the viewer's next click emits. For a document
//     the UI watermarks and marks OBS-CONFIDENTIAL, handing out a link that
//     works without a session defeats the point of watermarking it.
//
// This also fixes a bucket that never existed: the viewer previously signed
// against `gml-resources`, while the object store only ever created
// `gml-videos-original`, `gml-videos-hls`, `gml-posters` and `gml-pdfs`. Every
// PDF view 502'd, and the failure was indistinguishable from storage being down.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { resources } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { storage, BUCKETS } from "@/lib/video/storage";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const [res] = await db
    .select({ id: resources.id, name: resources.name, fileKey: resources.fileKey, kind: resources.kind })
    .from(resources)
    .where(eq(resources.id, id))
    .limit(1);

  // Reading material is programme-wide by design -- any authenticated member of
  // staff may open it -- so there is no per-object ownership check here, unlike
  // video. A missing row still returns 404 rather than a distinct error.
  if (!res || !res.fileKey) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // SM-9: every document read is attributable. Written before the bytes move,
  // so a transfer that dies mid-stream is still recorded as an access.
  void recordAudit({
    action: "resource.pdf.view",
    entityType: "resource",
    entityId: id,
    metadata: { kind: res.kind, fileKey: res.fileKey },
  });

  let stream;
  try {
    stream = await storage.stream(BUCKETS.pdfs, res.fileKey);
  } catch {
    return NextResponse.json({ error: "object_unavailable" }, { status: 502 });
  }

  return new NextResponse(stream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(stream.size),
      // inline so the browser's viewer renders it in the watermarked shell
      // rather than downloading a clean copy.
      "Content-Disposition": `inline; filename="${res.name.replace(/[^\w.\- ]+/g, "_")}.pdf"`,
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
