// /videos/[id] — HLS player page with signed URL + watermark.

import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { actorFrom, assertCanAccessVideo } from "@/lib/authz";
import { redirect } from "next/navigation";
import { recordAudit } from "@/lib/audit";
import { HlsPlayer } from "@/components/video/HlsPlayer";
import { ExternalEmbed } from "@/components/video/ExternalEmbed";

export const dynamic = "force-dynamic";

export default async function VideoPlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // OWNERSHIP GATE. This was the single highest-severity IDOR in the app: the
  // page called auth(), selected the video by id with NO ownership predicate,
  // and then minted a playable media token. Any signed-in teacher could play any
  // video in the programme -- including mentorship meeting recordings and mentee
  // quarterly videos -- from a guessed or observed UUID. The check must run
  // BEFORE the player source is built below -- and it now runs AGAIN inside
  // /api/media/playlist/[id] on every playlist fetch, so losing access revokes
  // playback rather than waiting for a token to expire.
  //
  // assertCanAccessVideo returns the row, so this replaces the old SELECT rather
  // than adding a query. It notFound()s (not 403) so an unauthorised id is
  // indistinguishable from a non-existent one.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const video = await assertCanAccessVideo(actor, id);

  const hdr = await headers();
  const ip = hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdr.get("x-real-ip") ?? "unknown";

  // Audit the view
  void recordAudit({
    action: "video.view",
    entityType: "video_submission",
    entityId: id,
    metadata: { source: video.source, status: video.status },
  });

  // The playlist route re-checks authorization from the session on every
  // request, so there is no token to mint, leak, or bind to an IP prefix. It
  // returns an .m3u8 whose segment lines are signed Storage URLs, and the
  // browser pulls those directly from Supabase's CDN -- no video byte passes
  // through this server.
  let playerSrc: string | null = null;
  if (video.hlsMasterKey && video.status === "ready") {
    playerSrc = `/api/media/playlist/${id}`;
  }

  const watermark = `${session.user.name ?? session.user.email ?? "viewer"} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;

  const statusChipKind =
    video.status === "ready"
      ? "chip-lichen"
      : video.status === "transcoding" || video.status === "queued"
        ? "chip-saffron"
        : video.status === "failed"
          ? "chip-rust"
          : "";
  const uploadedLabel = video.createdAt
    ? new Date(video.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "—";
  const durationLabel = video.durationSec
    ? `${Math.floor(video.durationSec / 60)}m ${String(video.durationSec % 60).padStart(2, "0")}s`
    : "—";

  return (
    <div>
      <div className="page-header">
        <Link href="/videos" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
          ← Library
        </Link>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 24 }}>
          Video review ·{" "}
          <span className="mono" style={{ fontSize: 16, color: "var(--ink-3)" }}>
            {id}
          </span>
        </h1>
        <div className="label" style={{ marginTop: 6 }}>
          {video.contextType.replace("_", " ")} · via {video.source}
        </div>
      </div>

      <div
        className="page-body"
        style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18 }}
      >
        <SectionCard title="Player" sub="Watermarked · streamed · download disabled">
          <div style={{ padding: 14, position: "relative" }}>
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
            <p
              style={{
                marginTop: 12,
                fontSize: 12,
                color: "var(--ink-3)",
                lineHeight: 1.5,
              }}
            >
              This video is watermarked with your name and the current timestamp.
              Download is disabled; right-click is blocked. Sharing the URL with
              others won&apos;t work — signed links are bound to your network connection.
            </p>
          </div>
        </SectionCard>

        <SectionCard title="Metadata">
          <div style={{ padding: "0 14px 10px", fontSize: 12 }}>
            <KVRow label="Video ID">
              <span className="mono" style={{ fontSize: 11 }}>{id}</span>
            </KVRow>
            <KVRow label="Caption">
              {video.captionRaw ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
            </KVRow>
            <KVRow label="Source">
              <span className="chip">{video.source}</span>
            </KVRow>
            <KVRow label="Context">
              <span className="chip chip-indigo">{video.contextType.replace("_", " ")}</span>
            </KVRow>
            <KVRow label="Status">
              <span className={`chip ${statusChipKind}`}>{video.status}</span>
            </KVRow>
            <KVRow label="Duration">
              <span className="mono" style={{ fontSize: 11 }}>{durationLabel}</span>
            </KVRow>
            <KVRow label="Uploaded">
              <span className="mono" style={{ fontSize: 11 }}>{uploadedLabel}</span>
            </KVRow>
            <KVRow label="Watermark">
              <span className="mono" style={{ fontSize: 11 }}>
                {session.user.name ?? session.user.email ?? "viewer"}
              </span>
            </KVRow>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card card-hi" style={{ overflow: "hidden" }}>
      <header
        style={{
          padding: "10px 18px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
        }}
      >
        <div style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>
          {title}
        </div>
        {sub ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "100px 1fr",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        alignItems: "flex-start",
      }}
    >
      <span className="label" style={{ paddingTop: 2 }}>{label}</span>
      <div
        style={{
          fontSize: 13,
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}
