// /videos/[id] — HLS player page with signed URL + watermark.

import Link from "next/link";
import { auth } from "@/auth";
import { actorFrom, assertCanAccessVideo, videoGateRequired } from "@/lib/authz";
import { redirect } from "next/navigation";
import { recordAudit } from "@/lib/audit";
import { HlsPlayer } from "@/components/video/HlsPlayer";
import { signPosterUrls } from "@/lib/video/storage";
import { ExternalEmbed } from "@/components/video/ExternalEmbed";

export const dynamic = "force-dynamic";

const CONTEXT_HEADINGS: Record<string, string> = {
  observation_cycle: "Classroom observation video",
  teach_back: "Teach-back video",
  mentor_meeting: "Mentor meeting recording",
  mentee_quarterly: "Mentee quarterly video",
  classroom_session: "Classroom session video",
  generic: "Video",
};

function contextHeading(contextType: string): string {
  return CONTEXT_HEADINGS[contextType] ?? "Video";
}

export default async function VideoPlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

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

  // SECTION GATE. A mentorship or observation video is served only to a user
  // holding that section's live grant, as inside /mentorship and /observation
  // (see videoGateRequired in lib/authz.ts). Checked after ownership, and
  // before the view is audited or a player source is built.
  const gate = await videoGateRequired(actor, video);
  if (gate) redirect(`/gate/${gate}?next=${encodeURIComponent(`/videos/${id}`)}`);

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
  // The frame the worker grabbed for this video, so the player does not open
  // black. Signed only now, after the ownership and gate checks above.
  const poster = playerSrc && video.posterKey ? (await signPosterUrls([video.posterKey])).get(video.posterKey) : undefined;

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
        {/* Named for what it is; the id is in the Metadata card below. */}
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 24 }}>{contextHeading(video.contextType)}</h1>
        <div className="label" style={{ marginTop: 6 }}>
          {video.contextType.replace("_", " ")} · via {video.source}
        </div>
      </div>

      {/* Player above metadata below 768 px, beside it above. This was an
          inline "1.6fr 1fr", which held on a phone: a 131 px player beside a
          100 px column whose values SectionCard's overflow:hidden clipped
          away entirely. */}
      <div className="page-body grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard title="Player" sub="Watermarked · streamed">
          <div style={{ padding: 14, position: "relative" }}>
            {video.source === "external_link" && video.externalUrl ? (
              <ExternalEmbed url={video.externalUrl} watermark={watermark} />
            ) : playerSrc ? (
              <HlsPlayer src={playerSrc} watermark={watermark} videoId={id} poster={poster} />
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
              {/* What is true. This said "Download is disabled" and "signed
                  links are bound to your network connection": the IP binding
                  went with the old token scheme, and the segment URLs are
                  bearer links that work from anywhere until they expire. */}
              Your name and the time are shown over this video, and every view is
              logged. Playback links expire within a few hours. Please do not share,
              download or re-record classroom videos.
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
        // minmax(0, ...): a bare 1fr column is at least as wide as its
        // content, and a 36-character video id is wider than a phone's card.
        gridTemplateColumns: "100px minmax(0, 1fr)",
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
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </div>
    </div>
  );
}
