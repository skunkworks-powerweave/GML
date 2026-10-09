// /videos/[id] — HLS player page with signed URL + watermark.

import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";
import { actorFrom, assertCanAccessVideo, videoGateRequired } from "@/lib/authz";
import { redirect } from "next/navigation";
import { recordAudit } from "@/lib/audit";
import { HlsPlayer } from "@/components/video/HlsPlayer";
import { signPosterUrls } from "@/lib/video/storage";
import { contextTypeLabel, isVideoProcessing, sourceLabel, statusLabel, type VideoTranslate } from "@/lib/video/labels";
import { RefreshWhileProcessing } from "@/components/video/RefreshWhileProcessing";
import { ExternalEmbed } from "@/components/video/ExternalEmbed";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("video");
  return { title: t("detail.metaTitle") };
}

/** The page's heading for each context (video.detail.heading.*). */
const CONTEXT_HEADINGS: ReadonlySet<string> = new Set([
  "observation_cycle",
  "teach_back",
  "mentor_meeting",
  "mentee_quarterly",
  "classroom_session",
  "generic",
]);

function contextHeading(t: VideoTranslate, contextType: string): string {
  return t(`detail.heading.${CONTEXT_HEADINGS.has(contextType) ? contextType : "generic"}`);
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

  const t = await getTranslations("video");
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  const viewer = session.user.name ?? session.user.email ?? t("detail.viewer");
  const watermark = `${viewer} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;

  const statusChipKind =
    video.status === "ready"
      ? "chip-lichen"
      : video.status === "transcoding" || video.status === "queued"
        ? "chip-saffron"
        : video.status === "failed"
          ? "chip-rust"
          : "";
  const uploadedLabel = video.createdAt
    ? new Date(video.createdAt).toLocaleDateString(intl, { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
    : "—";
  const durationLabel = video.durationSec
    ? t("detail.duration", {
        minutes: Math.floor(video.durationSec / 60),
        seconds: String(video.durationSec % 60).padStart(2, "0"),
      })
    : "—";

  return (
    <div>
      {/* Still processing: the player appears by itself once it is ready. */}
      <RefreshWhileProcessing active={isVideoProcessing(video.status)} />
      <div className="page-header">
        <Link href="/videos" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
          {t("detail.back")}
        </Link>
        {/* Named for what it is; the id is in the Metadata card below. */}
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 24 }}>{contextHeading(t, video.contextType)}</h1>
        <div className="label" style={{ marginTop: 6 }}>
          {t("detail.contextVia", { context: contextTypeLabel(t, video.contextType), source: sourceLabel(t, video.source) })}
        </div>
      </div>

      {/* Player above metadata below 768 px, beside it above. This was an
          inline "1.6fr 1fr", which held on a phone: a 131 px player beside a
          100 px column whose values SectionCard's overflow:hidden clipped
          away entirely. */}
      <div className="page-body grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard title={t("detail.player")} sub={t("detail.playerSub")}>
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
                  ? t("detail.state.transcoding")
                  : video.status === "received"
                    ? t("detail.state.received")
                    : video.status === "failed"
                      ? t("detail.state.failed")
                      : t("detail.state.none")}
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
              {t("detail.notice")}
            </p>
          </div>
        </SectionCard>

        <SectionCard title={t("detail.metadata")}>
          <div style={{ padding: "0 14px 10px", fontSize: 12 }}>
            <KVRow label={t("detail.field.videoId")}>
              <span className="mono" style={{ fontSize: 11 }}>{id}</span>
            </KVRow>
            <KVRow label={t("detail.field.caption")}>
              {video.captionRaw ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
            </KVRow>
            <KVRow label={t("detail.field.source")}>
              <span className="chip">{sourceLabel(t, video.source)}</span>
            </KVRow>
            <KVRow label={t("detail.field.context")}>
              <span className="chip chip-indigo">{contextTypeLabel(t, video.contextType)}</span>
            </KVRow>
            <KVRow label={t("detail.field.status")}>
              <span className={`chip ${statusChipKind}`}>{statusLabel(t, video.status)}</span>
            </KVRow>
            <KVRow label={t("detail.field.duration")}>
              <span className="mono" style={{ fontSize: 11 }}>{durationLabel}</span>
            </KVRow>
            <KVRow label={t("detail.field.uploaded")}>
              <span className="mono" style={{ fontSize: 11 }}>{uploadedLabel}</span>
            </KVRow>
            <KVRow label={t("detail.field.watermark")}>
              <span className="mono" style={{ fontSize: 11 }}>
                {viewer}
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
