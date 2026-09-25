// /videos — library of all video_submissions, filter by status.
// 1:1 port of `videos.jsx` layout.
//
// Spec 126 (Workflow Run 10 frontend parity) — the "WhatsApp ingest log"
// header button used to point at /admin/audit?action=whatsapp. which
// matched zero rows (the audit-log surface has no LIKE filter). It now
// links to the dedicated /admin/whatsapp-log surface and is hidden from
// roles other than programme_admin + super_admin (programme oversight).
//
// Spec 132 (Workflow Run 11 frontend-parity) — the Upload button used to
// link to /uploads as a placeholder. It now opens a client-side modal
// (UploadModal) that surfaces the PRIMARY WhatsApp ingest path
// alongside the secondary direct-browser-upload path. The /uploads
// route still exists for the teacher's own "My Uploads" tray; the modal
// is the discovery point from the library header.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): the status filter
// used to run client-side over a pre-fetched 100-row array. It now applies
// directly in the SQL WHERE so a future deep-paged library still narrows
// at the DB. Adds a ?source= filter (whatsapp / direct / external_link /
// google_drive) so operators can scope by ingest channel.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions } from "@gml/db/schema";
import { auth } from "@/auth";
import { actorFrom, lockedVideoScope, videoVisibilityFilter } from "@/lib/authz";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { UploadModal } from "@/components/video/UploadModal";
import { assertEnv } from "@/lib/env";
import { getSystemSettings } from "@/lib/system-settings";
import { signPosterUrls } from "@/lib/video/storage";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  received: "received",
  queued: "queued",
  transcoding: "transcoding",
  ready: "ready",
  failed: "failed",
  review_pending: "review pending",
  reviewed: "reviewed",
};

const STATE_CHIP: Record<string, string> = {
  ready: "chip-lichen",
  transcoding: "chip-saffron",
  queued: "chip",
  received: "chip",
  failed: "chip-rust",
  review_pending: "chip-saffron",
  reviewed: "chip-indigo",
};

const STATUS_VALUES = new Set([
  "received",
  "queued",
  "transcoding",
  "ready",
  "failed",
  "review_pending",
  "reviewed",
]);
const SOURCE_VALUES = new Set([
  "direct",
  "whatsapp",
  "external_link",
  "google_drive",
]);
type VideoStatus =
  | "received"
  | "queued"
  | "transcoding"
  | "ready"
  | "failed"
  | "review_pending"
  | "reviewed";
type VideoSource = "direct" | "whatsapp" | "external_link" | "google_drive";

export default async function VideoLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; source?: string }>;
}) {
  const sp = await searchParams;
  const filter = STATUS_VALUES.has(sp.status ?? "") ? sp.status! : undefined;
  const sourceFilter = SOURCE_VALUES.has(sp.source ?? "") ? sp.source! : undefined;

  // Spec 126: only programme-oversight roles see the WhatsApp ingest log
  // header button. Teachers / observers / mentors get no affordance at all
  // (they would 403 at the page boundary anyway, but rendering a dead
  // button breaks the trust contract — same reasoning as Tier H spec 119).
  const session = await auth();
  const canSeeWhatsappLog = hasAnyRole(session?.user?.role, [
    "programme_admin",
    "super_admin",
  ]);

  // Spec 168 — surface the programme-configured default quality in the
  // upload modal's browser-upload explainer. Falls back to "480p" (the
  // shipped pipeline default) if the singleton row hasn't bootstrapped.
  const sysSettings = await getSystemSettings();

  // Spec 129: build the WHERE clause server-side from URL searchParams.
  const conds: SQL[] = [];

  // VISIBILITY SCOPE. Until now this query had no user predicate at all: its
  // only conditions were the optional status/source filters, so EVERY
  // authenticated user -- teachers included -- could page through the whole
  // programme's video library, mentorship meeting recordings and mentee
  // quarterly videos among them. Chained with the /videos/[id] IDOR, a teacher
  // could then open any of them.
  //
  // This has to be a WHERE clause rather than a post-fetch filter: the status
  // counts below aggregate over the same predicate, so filtering in JS would
  // still leak the totals.
  //
  // `scopeConds` is the part of the predicate BOTH queries must share. Keeping
  // it as its own array is the fix for a leak that survived the original
  // visibility work: the paragraph above was written, the row query was
  // corrected, and then the GROUP BY below was left with no predicate at all --
  // so a teacher was shown the row count of the entire programme's library
  // while being served none of it. The comment described the right design and
  // the code did not implement it, which is the failure mode a shared array
  // makes structurally impossible.
  const scopeConds: SQL[] = [];
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const visibility = await videoVisibilityFilter(actor);
  if (visibility) scopeConds.push(visibility);
  // The section gate: mentorship and observation videos only once that
  // section is unlocked (own uploads excepted). Separate from the visibility
  // predicate, which is undefined for admins -- and admins are gated too.
  const locked = await lockedVideoScope(actor);
  if (locked) scopeConds.push(locked);

  // The source filter narrows BOTH: with ?source=whatsapp the chips should
  // count WhatsApp videos. The STATUS filter deliberately does not -- the chips
  // are per-status, so scoping them by the selected status would make every
  // chip but one read zero.
  if (sourceFilter) scopeConds.push(eq(videoSubmissions.source, sourceFilter as VideoSource));

  conds.push(...scopeConds);
  if (filter) conds.push(eq(videoSubmissions.status, filter as VideoStatus));

  const rows = await db
    .select({
      id: videoSubmissions.id,
      source: videoSubmissions.source,
      status: videoSubmissions.status,
      durationSec: videoSubmissions.durationSec,
      createdAt: videoSubmissions.createdAt,
      contextType: videoSubmissions.contextType,
      contextId: videoSubmissions.contextId,
      hlsKey: videoSubmissions.hlsMasterKey,
      posterKey: videoSubmissions.posterKey,
    })
    .from(videoSubmissions)
    .where(conds.length === 0 ? undefined : and(...conds))
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(100);

  // The poster frame the worker made for each video, signed in one batch --
  // only for rows the scope above already allowed. Empty on a Storage error:
  // the cards then show their placeholder, as they always did.
  const posterUrls = await signPosterUrls(rows.map((r) => r.posterKey));

  // Per-status counts as a single GROUP BY, over the SAME visibility scope as
  // the rows above. Without `scopeConds` here this aggregate ran unfiltered, so
  // the chips reported totals for the whole programme -- including mentorship
  // recordings and mentee quarterly videos -- to a teacher who could open none
  // of them. A count is not a lesser disclosure than a row: "47 mentor
  // meetings" is exactly the fact the visibility scope exists to withhold.
  const statusCountRows = await db
    .select({
      status: videoSubmissions.status,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(videoSubmissions)
    .where(scopeConds.length === 0 ? undefined : and(...scopeConds))
    .groupBy(videoSubmissions.status);
  const totalVideos = statusCountRows.reduce((acc, r) => acc + r.n, 0);
  const countByStatus = (v: string) =>
    statusCountRows.find((r) => r.status === v)?.n ?? 0;
  const counts = {
    all: totalVideos,
    ready: countByStatus("ready"),
    transcoding: countByStatus("transcoding"),
    queued: countByStatus("queued"),
  };

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <div className="label">Video library</div>
            <h1 className="serif" style={{ fontSize: 28, marginTop: 4 }}>Submissions &amp; lesson recordings</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 6, maxWidth: 540 }}>
              Videos are watermarked per viewer and streamed in the browser, and every view is logged. WhatsApp
              uploads land here automatically once a teacher sends a video with the right caption code.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {/*
              Spec 132 — the upload trigger opens the WhatsApp / direct-upload
              modal, with the programme WhatsApp number from env.

              NO WHATSAPP_PHONE_NUMBER_ID FALLBACK. That variable is Meta's
              opaque phone-number ID for the Cloud API account -- a 15-digit
              internal identifier, not a dialable number. Being all digits, it
              passed every "looks like a number" check and was rendered into
              wa.me/<id>, which resolves to no WhatsApp account at all: a
              teacher on 2G following the programme's PRIMARY video path landed
              on "this person is not on WhatsApp". Resolving to null is
              correct, because the modal already hides the WhatsApp section
              entirely when the number is null. No link beats a wrong one.
            */}
            <UploadModal
              whatsappPhone={assertEnv().whatsappNumber.value ?? null}
              videoDefaultQuality={sysSettings?.videoDefaultQuality ?? "480p"}
            />
            {canSeeWhatsappLog && (
              <Link href="/admin/whatsapp-log" className="btn">WhatsApp ingest log</Link>
            )}
          </div>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <div className="card" style={{ display: "flex", padding: 10, gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {(
              [
                { v: undefined, l: "All", n: counts.all },
                { v: "ready", l: "Ready to review", n: counts.ready },
                { v: "transcoding", l: "Transcoding", n: counts.transcoding },
                { v: "queued", l: "Queued", n: counts.queued },
              ] as const
            ).map((f) => {
              const isActive = filter === f.v || (!filter && !f.v);
              const qs = new URLSearchParams();
              if (f.v) qs.set("status", f.v);
              if (sourceFilter) qs.set("source", sourceFilter);
              const q = qs.toString();
              const href = q ? `/videos?${q}` : "/videos";
              return (
                <Link
                  key={f.l}
                  href={href}
                  className="btn btn-sm"
                  style={{
                    background: isActive ? "var(--ink)" : "transparent",
                    color: isActive ? "var(--paper)" : "var(--ink-2)",
                    borderColor: isActive ? "var(--ink)" : "transparent",
                    boxShadow: "none",
                    textDecoration: "none",
                  }}
                >
                  {f.l} <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.n}</span>
                </Link>
              );
            })}
          </div>
          <div style={{ width: 1, height: 20, background: "var(--line)" }} />
          <form method="GET" action="/videos" style={{ display: "contents" }}>
            {filter ? <input type="hidden" name="status" value={filter} /> : null}
            <select
              name="source"
              defaultValue={sourceFilter ?? ""}
              className="text"
              style={{ padding: "5px 10px", fontSize: 12 }}
            >
              <option value="">All sources</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="direct">Direct</option>
              <option value="external_link">External link</option>
              <option value="google_drive">Google Drive</option>
            </select>
            <button type="submit" className="btn btn-sm">
              Apply
            </button>
          </form>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{rows.length} shown</span>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="card card-hi" style={{ padding: 32, color: "var(--ink-3)" }}>No videos.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            {rows.map((v) => (
              <Link
                key={v.id}
                href={`/videos/${v.id}`}
                className="card card-hi"
                style={{
                  overflow: "hidden",
                  textDecoration: "none",
                  color: "var(--ink)",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ position: "relative", aspectRatio: "16/9", background: "var(--paper-2)" }}>
                  {v.posterKey && posterUrls.get(v.posterKey) ? (
                    // lazy: about 13 KB each, fetched only when scrolled into
                    // view -- a library of 100 on a 2G phone otherwise pays for
                    // every one up front.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={posterUrls.get(v.posterKey)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : null}
                  <span
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--ink-3)",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                    }}
                  >
                    {v.hlsKey ? "▶ click to play" : "no preview"}
                  </span>
                  {v.status !== "ready" && (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(28,24,22,0.65)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--paper)",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        gap: 8,
                      }}
                    >
                      {STATE_LABEL[v.status]}…
                    </div>
                  )}
                </div>
                <div style={{ padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>{v.id.slice(0, 10)}</span>
                    <span className={`chip ${STATE_CHIP[v.status] ?? ""}`}>{STATE_LABEL[v.status]}</span>
                  </div>
                  <div style={{ fontWeight: 500, marginTop: 6, fontSize: 13 }}>{v.contextType.replace("_", " ")}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    via {v.source}
                    {v.durationSec ? ` · ${Math.floor(v.durationSec / 60)} min` : ""}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 8,
                      fontSize: 11,
                      color: "var(--ink-3)",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    <span>
                      {v.createdAt
                        ? new Date(v.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                        : "—"}
                    </span>
                    <span>{v.source}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
