// /videos/[id] — HLS player page with signed URL + watermark.

import { notFound } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions, files, users as usersTable } from "@gml/db/schema";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { signMediaToken } from "@/lib/video/signed-url";
import { recordAudit } from "@/lib/audit";
import { HlsPlayer } from "@/components/video/HlsPlayer";
import { ExternalEmbed } from "@/components/video/ExternalEmbed";

export const dynamic = "force-dynamic";

export default async function VideoPlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const [video] = await db.select().from(videoSubmissions).where(eq(videoSubmissions.id, id)).limit(1);
  if (!video) notFound();

  const hdr = await headers();
  const ip = hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdr.get("x-real-ip") ?? "unknown";

  // Audit the view
  void recordAudit({
    action: "video.view",
    entityType: "video_submission",
    entityId: id,
    metadata: { source: video.source, status: video.status },
  });

  let playerSrc: string | null = null;
  if (video.hlsMasterKey && video.status === "ready") {
    const token = signMediaToken({
      bucket: "gml-videos-hls",
      objectKey: video.hlsMasterKey,
      userId,
      ip,
    });
    playerSrc = `/api/media/${token}`;
  }

  const watermark = `${session.user.name ?? session.user.email ?? "viewer"} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;

  return (
    <div>
      <header style={{ marginBottom: 18 }}>
        <Link href="/videos" style={{ fontSize: 12, color: "var(--ink-3)" }}>
          ← Library
        </Link>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginTop: 8 }}>
          Video · {video.contextType.replace("_", " ")} · via {video.source}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 24, marginTop: 4 }}>
          {video.captionRaw ?? `Video ${id.slice(0, 8)}`}
        </h1>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
          Status: <code style={{ fontFamily: "var(--mono)" }}>{video.status}</code>
          {video.durationSec ? ` · ${Math.round(video.durationSec / 60)} min` : ""}
          {video.createdAt
            ? ` · uploaded ${new Date(video.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`
            : ""}
        </div>
      </header>

      <section style={{ maxWidth: 920 }}>
        {video.source === "external_link" && video.externalUrl ? (
          <ExternalEmbed url={video.externalUrl} watermark={watermark} />
        ) : playerSrc ? (
          <HlsPlayer src={playerSrc} watermark={watermark} videoId={id} />
        ) : (
          <div
            style={{
              aspectRatio: "16/9",
              background: "#000",
              color: "var(--paper)",
              borderRadius: "var(--r-3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              padding: 16,
              textAlign: "center",
            }}
          >
            {video.status === "transcoding" || video.status === "queued"
              ? "Transcoding in progress. Refresh in a minute or two."
              : video.status === "received"
                ? "Received. Waiting for the worker to pick it up."
                : video.status === "failed"
                  ? "Transcode failed. Contact your programme admin."
                  : "No playable rendition."}
          </div>
        )}
      </section>

      <section style={{ marginTop: 18, maxWidth: 920, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
        This video is watermarked with your name and the current timestamp. Download is disabled; right-click is blocked.
        Sharing the URL with others won't work — signed links are bound to your network connection.
      </section>
    </div>
  );
}
