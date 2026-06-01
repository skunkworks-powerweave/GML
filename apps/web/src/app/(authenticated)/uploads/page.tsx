// /uploads — teacher's "My uploads" personal landing.
// 1:1 port of `LMS GML Frontend/forms.jsx::UploadsPage` (lines 342-375).
// - Three explainer cards (WhatsApp PRIMARY / browser tus / in-app record)
// - Inline <UploadProgress /> tray (spec 045) for browser uploads
// - Table of viewer's own video_submissions (most recent 50), joined with files
//   for the original filename and with observation_cycles for the linked cycle code.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@gml/db";
import { videoSubmissions, files, observationCycles } from "@gml/db/schema";
import { UploadProgress } from "@/components/video/UploadProgress";

export const dynamic = "force-dynamic";

// Reused from /videos/page.tsx (spec 067) so the visual language is identical.
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

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  direct: "Web",
  external_link: "External",
};

const SOURCE_BG: Record<string, string> = {
  whatsapp: "var(--lichen-soft)",
  direct: "var(--indigo-soft)",
  external_link: "var(--paper-2)",
};

// Human label for context_type rows that don't surface a code.
const CONTEXT_LABEL: Record<string, string> = {
  teach_back: "Teach-back",
  mentor_meeting: "Mentor meeting",
  mentee_quarterly: "Mentee quarterly",
  classroom_session: "Classroom session",
  generic: "—",
};

const EXPLAINER_CARDS = [
  {
    icon: "wa",
    title: "Forward via WhatsApp",
    desc:
      "Send your video to +91 90600 22013 with caption #c2026-004 (or your active cycle ID). Fastest on 2G/3G.",
    accent: "var(--lichen)",
    primary: true,
    cta: "Open WhatsApp",
    href: "https://wa.me/919060022013?text=" + encodeURIComponent("#cycle- "),
  },
  {
    icon: "up",
    title: "Upload here",
    desc:
      "Drag a file to this card. Resumes on disconnect. Max file 500 MB. We'll transcode to HLS automatically.",
    accent: "var(--indigo)",
    primary: false,
    cta: "Start",
    href: "#upload-tray",
  },
  {
    icon: "rec",
    title: "Record in-app",
    desc: "Open camera here in the app. Saves to your phone first; uploads when you have wifi.",
    accent: "var(--saffron)",
    primary: false,
    cta: "Start",
    href: "#upload-tray",
  },
] as const;

function humanSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatIST(d: Date | null): string {
  if (!d) return "—";
  // YYYY-MM-DD HH:MM in Asia/Kolkata, monospace-friendly.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export default async function UploadsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/forbidden");
  }
  const viewerId = session.user.id;

  const rows = await db
    .select({
      id: videoSubmissions.id,
      source: videoSubmissions.source,
      status: videoSubmissions.status,
      contextType: videoSubmissions.contextType,
      contextId: videoSubmissions.contextId,
      createdAt: videoSubmissions.createdAt,
      durationSec: videoSubmissions.durationSec,
      filename: files.originalFilename,
      sizeBytes: files.sizeBytes,
      mimeType: files.mimeType,
      cycleCode: observationCycles.code,
    })
    .from(videoSubmissions)
    .leftJoin(files, eq(videoSubmissions.fileId, files.id))
    .leftJoin(
      observationCycles,
      and(
        eq(videoSubmissions.contextType, "observation_cycle"),
        eq(videoSubmissions.contextId, observationCycles.id),
      ),
    )
    .where(eq(videoSubmissions.submittedByUserId, viewerId))
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(50);

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          My uploads ·{" "}
          <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)" }}>मेरे अपलोड</span>
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Submit a lesson video
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 6, maxWidth: 560 }}>
          Three ways to submit. Pick whatever works on your network today.
        </p>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
          marginBottom: 18,
        }}
      >
        {EXPLAINER_CARDS.map((c) => (
          <article
            key={c.title}
            style={{
              padding: 22,
              background: c.primary ? "var(--card-hi)" : "var(--card)",
              border: c.primary ? "2px solid var(--ink)" : "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: c.accent,
                color: "var(--paper)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--mono)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
              aria-hidden
            >
              {c.icon}
            </div>
            <div style={{ fontFamily: "var(--serif)", fontSize: 18 }}>{c.title}</div>
            <p style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5, margin: 0 }}>
              {c.desc}
            </p>
            <a
              href={c.href}
              target={c.primary ? "_blank" : undefined}
              rel={c.primary ? "noopener noreferrer" : undefined}
              style={{
                marginTop: "auto",
                alignSelf: "flex-start",
                padding: "7px 14px",
                background: c.primary ? "var(--ink)" : "var(--card-hi)",
                color: c.primary ? "var(--paper)" : "var(--ink)",
                border: c.primary ? "1px solid var(--ink)" : "1px solid var(--line-2)",
                borderRadius: "var(--r-2)",
                fontSize: 12,
                fontWeight: 500,
                textDecoration: "none",
              }}
            >
              {c.cta}
            </a>
          </article>
        ))}
      </section>

      <section id="upload-tray" style={{ marginBottom: 22 }}>
        <UploadProgress contextType="generic" />
      </section>

      <section
        style={{
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          padding: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>My recent uploads</h2>
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
            {rows.length} {rows.length === 1 ? "video" : "videos"} · most recent first
          </span>
        </div>

        {rows.length === 0 ? (
          <div
            style={{
              padding: "32px 16px",
              textAlign: "center",
              color: "var(--ink-3)",
              fontSize: 13,
              border: "1px dashed var(--line)",
              borderRadius: "var(--r-2)",
              background: "var(--paper)",
            }}
          >
            <div style={{ fontWeight: 500, color: "var(--ink-2)", marginBottom: 4 }}>
              You haven&apos;t uploaded anything yet.
            </div>
            <div style={{ fontSize: 12 }}>
              Use one of the three options above — WhatsApp is the fastest on a flaky connection.
            </div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "var(--ink-3)" }}>
                  {["File", "Source", "Linked to", "Size", "State", "Date"].map((h) => (
                    <th
                      key={h}
                      style={{
                        fontWeight: 500,
                        padding: "8px 10px",
                        borderBottom: "1px solid var(--line)",
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isReady = r.status === "ready";
                  const filename = r.filename ?? "(unnamed)";
                  const isPdf = r.mimeType?.startsWith("application/pdf");
                  const linkedTo =
                    r.contextType === "observation_cycle"
                      ? r.cycleCode ?? "—"
                      : CONTEXT_LABEL[r.contextType] ?? "—";
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--hairline)" }}>
                      <td style={{ padding: "10px" }}>
                        <span
                          aria-hidden
                          style={{
                            display: "inline-block",
                            width: 18,
                            marginRight: 6,
                            color: "var(--ink-3)",
                            fontFamily: "var(--mono)",
                            fontSize: 10,
                          }}
                        >
                          {isPdf ? "PDF" : "VID"}
                        </span>
                        {isReady ? (
                          <Link
                            href={`/videos/${r.id}`}
                            style={{
                              color: "var(--ink)",
                              textDecoration: "none",
                              borderBottom: "1px solid var(--line-2)",
                            }}
                          >
                            {filename}
                          </Link>
                        ) : (
                          <span style={{ color: "var(--ink-2)" }}>{filename}</span>
                        )}
                      </td>
                      <td style={{ padding: "10px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            background: SOURCE_BG[r.source] ?? "var(--paper-2)",
                            color: "var(--ink-2)",
                            borderRadius: 999,
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          {SOURCE_LABEL[r.source] ?? r.source}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "10px",
                          fontFamily:
                            r.contextType === "observation_cycle" ? "var(--mono)" : undefined,
                          color: "var(--ink-2)",
                        }}
                      >
                        {linkedTo}
                      </td>
                      <td
                        style={{
                          padding: "10px",
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--ink-3)",
                        }}
                      >
                        {humanSize(r.sizeBytes)}
                      </td>
                      <td style={{ padding: "10px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            background: STATE_BG[r.status] ?? "var(--paper-2)",
                            color: "var(--ink-2)",
                            borderRadius: 999,
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          {STATE_LABEL[r.status] ?? r.status}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "10px",
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--ink-3)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatIST(r.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
