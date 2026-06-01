// /videos — library of all video_submissions, filter by status.
// 1:1 port of `videos.jsx` layout.
//
// Spec 126 (Workflow Run 10 frontend parity) — the "WhatsApp ingest log"
// header button used to point at /admin/audit?action=whatsapp. which
// matched zero rows (the audit-log surface has no LIKE filter). It now
// links to the dedicated /admin/whatsapp-log surface and is hidden from
// roles other than programme_admin + super_admin (programme oversight).

import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions, observationCycles, teachers } from "@gml/db/schema";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";

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

export default async function VideoLibraryPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const filter = sp.status;

  // Spec 126: only programme-oversight roles see the WhatsApp ingest log
  // header button. Teachers / observers / mentors get no affordance at all
  // (they would 403 at the page boundary anyway, but rendering a dead
  // button breaks the trust contract — same reasoning as Tier H spec 119).
  const session = await auth();
  const canSeeWhatsappLog = hasAnyRole(session?.user?.role, [
    "programme_admin",
    "super_admin",
  ]);

  const baseRows = await db
    .select({
      id: videoSubmissions.id,
      source: videoSubmissions.source,
      status: videoSubmissions.status,
      durationSec: videoSubmissions.durationSec,
      createdAt: videoSubmissions.createdAt,
      contextType: videoSubmissions.contextType,
      contextId: videoSubmissions.contextId,
      hlsKey: videoSubmissions.hlsMasterKey,
    })
    .from(videoSubmissions)
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(100);

  const rows = filter ? baseRows.filter((r) => r.status === filter) : baseRows;
  const counts = {
    all: baseRows.length,
    ready: baseRows.filter((r) => r.status === "ready").length,
    transcoding: baseRows.filter((r) => r.status === "transcoding").length,
    queued: baseRows.filter((r) => r.status === "queued").length,
  };

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <div className="label">Video library</div>
            <h1 className="serif" style={{ fontSize: 28, marginTop: 4 }}>Submissions &amp; lesson recordings</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 6, maxWidth: 540 }}>
              All videos are watermarked per viewer, streamed as HLS, and never available for direct download. WhatsApp
              uploads land here automatically once a teacher sends a video with the right caption code.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link href="/uploads" className="btn btn-primary">Upload</Link>
            {canSeeWhatsappLog && (
              <Link href="/admin/whatsapp-log" className="btn">WhatsApp ingest log</Link>
            )}
          </div>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <div className="card" style={{ display: "flex", padding: 10, gap: 12, alignItems: "center" }}>
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
              return (
                <Link
                  key={f.l}
                  href={f.v ? `?status=${f.v}` : "/videos"}
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
