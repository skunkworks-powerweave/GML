// /uploads — teacher's "My uploads" personal landing.
// 1:1 port of `LMS GML Frontend/forms.jsx::UploadsPage` (lines 342-375).
// - Three explainer cards (WhatsApp PRIMARY / browser tus / in-app record)
// - Inline <UploadProgress /> tray (spec 045) for browser uploads
// - Table of viewer's own video_submissions (most recent 50), joined with files
//   for the original filename and with observation_cycles for the linked cycle code.
//
// Spec 135 (Workflow Run 12 final frontend-parity): on mobile we swap the
// explainer cards + UploadProgress tray for the dedicated MobileUploadRunner
// flow (full-screen Record / Pick → Preview → Upload progress). Desktop keeps
// the original three-card layout untouched. The recent-uploads table is
// rendered on both shells because viewing past submissions is identical work
// regardless of device.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@gml/db";
import { videoSubmissions, files, observationCycles } from "@gml/db/schema";
import { UploadProgress } from "@/components/video/UploadProgress";
import { MobileUploadRunner } from "@/components/video/MobileUploadRunner";
import { getDeviceType } from "@/lib/device";
import { assertEnv } from "@/lib/env";

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

// Maps video_submissions.status -> chip variant class (matches data.jsx STATUS_CHIPS).
const STATE_CHIP: Record<string, string> = {
  ready: "chip-lichen",
  transcoding: "chip-saffron",
  queued: "",
  received: "",
  failed: "chip-rust",
  review_pending: "chip-saffron",
  reviewed: "chip-indigo",
};

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  direct: "Web",
  external_link: "External",
};

const SOURCE_CHIP: Record<string, string> = {
  whatsapp: "chip-lichen",
  direct: "chip-indigo",
  external_link: "",
};

// Human label for context_type rows that don't surface a code.
const CONTEXT_LABEL: Record<string, string> = {
  teach_back: "Teach-back",
  mentor_meeting: "Mentor meeting",
  mentee_quarterly: "Mentee quarterly",
  classroom_session: "Classroom session",
  generic: "—",
};

/**
 * Built per request, because two of these cards were lying about the product.
 *
 *   WhatsApp   The number and the wa.me link were HARDCODED to
 *              +91 90600 22013, three lines above the same file's own
 *              env-driven `whatsappPhone`. Any deployment with a different
 *              programme number -- which is every deployment but the one this
 *              was typed on -- sent teachers to a stranger. When no number is
 *              configured the card is dropped entirely rather than shown with
 *              a dead link.
 *
 *   Drag       "Drag a file to this card" described a feature that does not
 *              exist: neither the card nor UploadProgress implements a single
 *              drag or drop handler, so a dropped video made the browser
 *              navigate away from the page and open the file instead, losing
 *              whatever was in progress. The copy now describes the button
 *              that is actually there.
 */
function explainerCards(whatsappPhone: string | null) {
  const dialable = whatsappPhone ? whatsappPhone.replace(/[^0-9]/g, "") : null;
  return [
    ...(whatsappPhone && dialable
      ? [
          {
            icon: "wa",
            title: "Forward via WhatsApp",
            desc: `Send your video to ${whatsappPhone} with the caption for your active cycle ID. Fastest on 2G/3G.`,
            accent: "var(--lichen)",
            primary: true,
            cta: "Open WhatsApp",
            href: `https://wa.me/${dialable}?text=${encodeURIComponent("#cycle- ")}`,
          },
        ]
      : []),
    {
      icon: "up",
      title: "Upload here",
      desc: "Choose a file below. Resumes on disconnect. Max file 500 MB. We'll transcode to HLS automatically.",
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
  ];
}

function humanSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  // Spec 135 — device-aware shell. The same env-var contract as
  // /videos UploadModal (spec 132) is reused for the WhatsApp fallback.
  // Spec 169 — `process.env.GML_WHATSAPP_NUMBER` is now read THROUGH
  // assertEnv() so a typo'd value (missing `+`, stray whitespace) falls
  // through to `WHATSAPP_PHONE_NUMBER_ID` / null and the downstream
  // UploadModal / MobileUploadRunner hide the WhatsApp path entirely
  // rather than rendering a broken wa.me link. The legacy env name is
  // preserved for backwards compatibility with deployments that pre-date
  // the GML_* override.
  const device = await getDeviceType();
  // See videos/page.tsx: WHATSAPP_PHONE_NUMBER_ID is Meta's opaque account id,
  // not a dialable number, and must never be used as a fallback here.
  const whatsappPhone = assertEnv().whatsappNumber.value ?? null;

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
      <div className="page-header">
        <div className="label">
          My uploads ·{" "}
          <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)" }}>
            मेरे अपलोड
          </span>
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>
          Submit a lesson video
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          Three ways to submit. Pick whatever works on your network today.
        </p>
      </div>

      <div className="page-body">
        {device === "mobile" ? (
          <section style={{ marginBottom: 22 }}>
            <MobileUploadRunner whatsappPhone={whatsappPhone} />
          </section>
        ) : null}

        {device === "desktop" ? (
          <>
            <section
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 14,
                marginBottom: 18,
              }}
            >
              {explainerCards(whatsappPhone).map((c) => (
                <article
                  key={c.title}
                  className={`card${c.primary ? " card-hi" : ""}`}
                  style={{
                    padding: 22,
                    border: c.primary ? "2px solid var(--ink)" : undefined,
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 10,
                      background: c.accent,
                      color: "white",
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
                  <div
                    style={{
                      fontFamily: "var(--serif)",
                      fontSize: 18,
                      marginTop: 12,
                    }}
                  >
                    {c.title}
                  </div>
                  <p
                    style={{
                      fontSize: 13,
                      color: "var(--ink-3)",
                      marginTop: 6,
                      lineHeight: 1.5,
                    }}
                  >
                    {c.desc}
                  </p>
                  <a
                    href={c.href}
                    target={c.primary ? "_blank" : undefined}
                    rel={c.primary ? "noopener noreferrer" : undefined}
                    className={`btn${c.primary ? " btn-primary" : ""}`}
                    style={{
                      marginTop: 12,
                      alignSelf: "flex-start",
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
          </>
        ) : null}

        <div className="card" style={{ padding: 22 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 600 }}>My recent uploads</div>
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {rows.length} {rows.length === 1 ? "video" : "videos"} · most
              recent first
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
              <div
                style={{
                  fontWeight: 500,
                  color: "var(--ink-2)",
                  marginBottom: 4,
                }}
              >
                You haven&apos;t uploaded anything yet.
              </div>
              <div style={{ fontSize: 12 }}>
                Use one of the three options above — WhatsApp is the fastest on
                a flaky connection.
              </div>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    {[
                      "File",
                      "Source",
                      "Linked to",
                      "Size",
                      "State",
                      "Date",
                    ].map((h) => (
                      <th key={h}>{h}</th>
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
                        ? (r.cycleCode ?? "—")
                        : (CONTEXT_LABEL[r.contextType] ?? "—");
                    const sourceChipCls = SOURCE_CHIP[r.source] ?? "";
                    const stateChipCls = STATE_CHIP[r.status] ?? "";
                    return (
                      <tr key={r.id}>
                        <td>
                          <span
                            aria-hidden
                            className="mono"
                            style={{
                              display: "inline-block",
                              width: 18,
                              marginRight: 6,
                              color: "var(--ink-3)",
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
                            <span style={{ color: "var(--ink-2)" }}>
                              {filename}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`chip ${sourceChipCls}`.trim()}>
                            {SOURCE_LABEL[r.source] ?? r.source}
                          </span>
                        </td>
                        <td
                          className={
                            r.contextType === "observation_cycle"
                              ? "mono"
                              : undefined
                          }
                          style={{ color: "var(--ink-2)" }}
                        >
                          {linkedTo}
                        </td>
                        <td
                          className="mono"
                          style={{ fontSize: 11, color: "var(--ink-3)" }}
                        >
                          {humanSize(r.sizeBytes)}
                        </td>
                        <td>
                          <span className={`chip ${stateChipCls}`.trim()}>
                            {STATE_LABEL[r.status] ?? r.status}
                          </span>
                        </td>
                        <td
                          className="mono"
                          style={{
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
        </div>
      </div>
    </div>
  );
}
