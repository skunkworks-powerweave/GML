// /repo/resource/[id]/view — in-browser PDF viewer (SM-4 deterrence stack).
//
// Server responsibilities:
//   1. auth() gate → /login redirect for anon.
//   2. Resolve the resource by id (must be active, must have a fileKey).
//   3. Point the viewer at /api/media/pdf/[id], a route that re-checks the
//      session on every request and streams the bytes. It used to mint a
//      5-minute HMAC token instead -- over a bucket named `gml-resources` that
//      nothing ever created, so every view 502'd, and as a bearer capability
//      that kept working after the viewer's session ended.
//   4. recordAudit({ action: "resource.pdf.view", entityType: "resource",
//      entityId: id }) — required by SM-9. Best-effort (the helper swallows
//      errors so a broken audit table can't take the viewer down).
//   5. Render <PdfViewer> + the SM-4 disclosure footer.
//
// Anti-download is a deterrent, not DRM — we say so out loud in the footer.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { resources } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { PdfViewer } from "@/components/pdf/PdfViewer";

export const dynamic = "force-dynamic";

export default async function RepoResourceViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const { id } = await params;

  const [res] = await db
    .select()
    .from(resources)
    .where(and(eq(resources.id, id), eq(resources.active, true)))
    .limit(1);
  if (!res) notFound();
  if (!res.fileKey) notFound();

  const hdr = await headers();
  const ip =
    hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    hdr.get("x-real-ip") ??
    "unknown";

  // SM-9 audit — every PDF view is recorded with user + entity + IP.
  // piiAudited=false because resources themselves don't carry learner PII;
  // the audit row's own metadata captures who viewed which document.
  void recordAudit({
    action: "resource.pdf.view",
    entityType: "resource",
    entityId: id,
    metadata: { piiAudited: false, kind: res.kind, fileKey: res.fileKey },
  });

  // Proxied through the app rather than redirected to a signed Storage URL, so
  // the document cannot be reopened from browser history without a session.
  // This also corrects the bucket: the old token named `gml-resources`, which
  // nothing ever created, so every PDF view 502'd.
  const signedUrl = `/api/media/pdf/${res.id}`;

  const watermark = `${session.user.email ?? session.user.name ?? "viewer"} · OBS-CONFIDENTIAL`;

  return (
    <div>
      <header style={{ marginBottom: 18 }}>
        <Link
          href={`/repo/resource/${res.id}`}
          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
        >
          ← {res.name}
        </Link>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginTop: 8,
          }}
        >
          {res.kind}{" "}
          <span style={{ fontFamily: "var(--mono)", textTransform: "none", letterSpacing: 0 }}>
            · {res.id.slice(0, 8)}
          </span>
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 24, marginTop: 4 }}>
          {res.name}
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 4 }}>
          In-browser viewer · signed URL expires in 5 minutes · refresh the page if it stops loading.
        </p>
      </header>

      <section style={{ maxWidth: 1080 }}>
        <PdfViewer src={signedUrl} watermark={watermark} resourceId={res.id} />
      </section>

      {/* SM-4 disclosure footer — anti-download deterrent is honest about its limits. */}
      <footer
        style={{
          marginTop: 14,
          maxWidth: 1080,
          padding: "10px 14px",
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-2)",
          fontSize: 12,
          color: "var(--ink-3)",
          lineHeight: 1.55,
        }}
      >
        PDF viewing is logged. Document is confidential — do not redistribute.
        (Anti-download is a deterrent, not DRM.)
      </footer>
    </div>
  );
}
