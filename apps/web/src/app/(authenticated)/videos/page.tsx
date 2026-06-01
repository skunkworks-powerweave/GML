// /videos — library of all video_submissions, filter by status.
// 1:1 port of `videos.jsx` layout.

import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions, observationCycles, teachers } from "@gml/db/schema";

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

const STATE_BG: Record<string, string> = {
  ready: "var(--lichen-soft)",
  transcoding: "var(--saffron-soft)",
  queued: "var(--paper-2)",
  received: "var(--paper-2)",
  failed: "var(--rust-soft)",
  review_pending: "var(--saffron-soft)",
  reviewed: "var(--indigo-soft)",
};

export default async function VideoLibraryPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const filter = sp.status;

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
      <header style={{ marginBottom: 22, display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
            Video library
          </div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Submissions &amp; lesson recordings</h1>
          <p style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 6, maxWidth: 540 }}>
            All videos are watermarked per viewer, streamed as HLS, and never available for direct download. WhatsApp
            uploads land here automatically once a teacher sends a video with the right caption code.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Link
            href="/uploads"
            style={{
              padding: "7px 12px",
              background: "var(--ink)",
              color: "var(--paper)",
              borderRadius: "var(--r-2)",
              fontSize: 12,
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Upload
          </Link>
          <Link
            href="/admin/audit?action=whatsapp."
            style={{
              padding: "7px 12px",
              background: "var(--card-hi)",
              color: "var(--ink)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-2)",
              fontSize: 12,
              textDecoration: "none",
            }}
          >
            WhatsApp ingest log
          </Link>
        </div>
      </header>

      <section style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {(
          [
            { v: undefined, l: "All", n: counts.all },
            { v: "ready", l: "Ready", n: counts.ready },
            { v: "transcoding", l: "Transcoding", n: counts.transcoding },
            { v: "queued", l: "Queued", n: counts.queued },
          ] as const
        ).map((f) => {
          const isActive = filter === f.v || (!filter && !f.v);
          return (
            <Link
              key={f.l}
              href={f.v ? `?status=${f.v}` : "/videos"}
              style={{
                padding: "6px 12px",
                background: isActive ? "var(--ink)" : "transparent",
                color: isActive ? "var(--paper)" : "var(--ink-2)",
                border: isActive ? "1px solid var(--ink)" : "1px solid transparent",
                borderRadius: "var(--r-2)",
                fontSize: 12,
                textDecoration: "none",
              }}
            >
              {f.l} <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.n}</span>
            </Link>
          );
        })}
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 14,
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "var(--ink-3)" }}>No videos.</div>
        ) : (
          rows.map((v) => (
            <Link
              key={v.id}
              href={`/videos/${v.id}`}
              style={{
                background: "var(--card-hi)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-3)",
                textDecoration: "none",
                color: "var(--ink)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ aspectRatio: "16/9", background: "var(--paper-2)", position: "relative" }}>
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
                <span
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    padding: "2px 8px",
                    background: STATE_BG[v.status] ?? "var(--paper-2)",
                    color: "var(--ink-2)",
                    borderRadius: 999,
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {STATE_LABEL[v.status]}
                </span>
              </div>
              <div style={{ padding: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{v.contextType.replace("_", " ")}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                  via {v.source}
                  {v.durationSec ? ` · ${Math.floor(v.durationSec / 60)} min` : ""}
                  {v.createdAt
                    ? ` · ${new Date(v.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
                    : ""}
                </div>
              </div>
            </Link>
          ))
        )}
      </section>
    </div>
  );
}
