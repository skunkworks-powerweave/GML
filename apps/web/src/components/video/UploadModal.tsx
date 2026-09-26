"use client";

// Spec 132 (Workflow Run 11 frontend-parity) — upload modal for /videos.
//
// JSX prototype reference: LMS GML Frontend/videos.jsx line 32 renders an
// `<Icon name="upload"/> Upload` button in the library header with no
// handler. This component is the missing modal it should open.
//
// Two upload paths are surfaced so the dialog matches the GML field
// reality:
//
//   1. **WhatsApp ingest** — the PRIMARY teacher path. Teachers in
//      Ladakh have flaky data and overwhelmingly upload from their
//      phones over WhatsApp. The modal surfaces the programme WhatsApp
//      number + the caption formats (OBS-<code> / TB-<uuid> / MM-<uuid> /
//      Q1-<uuid> and Q4-<uuid>) so a teacher who has never uploaded before knows
//      exactly what to send. A "Copy phone number" button puts the
//      digits on the clipboard.
//
//   2. **Direct browser upload** — the admin / mentor fallback. We
//      embed the existing UploadProgress client component with
//      contextType='generic' (the library page is not scoped to a
//      specific cycle / teach-back / mentor meeting). The component
//      already handles tus-js-client resumable uploads, progress bar,
//      and post-finish status display.
//
// Close semantics match the rest of the chrome (HelpPanel, FTUXTour,
// QuickFind):
//   - Esc closes the dialog (with a global keydown listener that is
//     only mounted while the dialog is open, so it doesn't fight the
//     ? / ⌘? help-panel shortcut).
//   - Click on the backdrop (the fixed-position overlay outside the
//     panel) closes.
//   - When the embedded UploadProgress finishes a file selection
//     (onComplete fires after tus reports success), we close the
//     dialog so the user sees the new row land in the library.
//
// SM-4 (anti-download): the dialog is a thin shell around existing
// UploadProgress + a static instructions card; it never receives or
// displays a video file URL. The watermarking + signed URL contract
// belongs to HlsPlayer.tsx, not here.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UploadProgress } from "./UploadProgress";

type UploadModalProps = {
  /** Programme WhatsApp number (E.164, no +). Falls back to a placeholder
   *  shown in italic when the deployment has not set GML_WHATSAPP_NUMBER. */
  whatsappPhone?: string | null;
  /** Spec 168 — default HLS rendition the worker pipeline emits, read from
   *  system_settings.videoDefaultQuality. Surfaced in the browser-upload
   *  explainer so the teacher knows what bitrate their lesson will become.
   *  Defaults to "480p" when the row hasn't bootstrapped yet — matches the
   *  pipeline reality (spec 041 deferred 720p, 1080p was never a goal). */
  videoDefaultQuality?: string | null;
};

// Spec 169 — when assertEnv() rejects GML_WHATSAPP_NUMBER (set-but-invalid
// or never configured) the videos page passes null. In that case the
// PRIMARY WhatsApp section is HIDDEN entirely so the modal never renders
// a broken wa.me hint or shows a `—` placeholder where a real phone
// belongs. The direct-browser-upload section remains available; admins
// and mentors can still upload, and the email/in-app paths in HelpPanel
// stay reachable for help.
function isUsableWhatsappPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const trimmed = phone.trim();
  if (trimmed.length === 0) return false;
  return /^\+?\d{8,15}$/.test(trimmed);
}

export function UploadModal({ whatsappPhone, videoDefaultQuality }: UploadModalProps) {
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Esc closes the dialog. Only mounted while open so we don't keep a
  // global listener live across the whole app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus management — when we close, return focus to the Upload trigger
  // so keyboard users don't jump back to the top of the page.
  useEffect(() => {
    if (open) {
      // Push focus into the dialog so screen readers announce it.
      const t = setTimeout(() => dialogRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    triggerRef.current?.focus?.();
    return undefined;
  }, [open]);

  async function onCopy() {
    if (!whatsappPhone) return;
    try {
      await navigator.clipboard.writeText(whatsappPhone);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 1500);
    } catch {
      // Clipboard API may be unavailable on http://localhost without
      // permissions. Fail silently — the number is visible on screen.
    }
  }

  function onUploadComplete() {
    // After a file finishes the tus handshake we close the dialog so the
    // teacher sees the new row land in the grid. The post-upload status
    // is still visible via the videos library list itself.
    setOpen(false);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-primary"
        data-testid="upload-trigger"
      >
        Upload
      </button>

      {open ? (
        <div
          // Backdrop — clicking it closes. The inner panel calls
          // stopPropagation so a click inside the dialog stays inside.
          role="presentation"
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(28,24,22,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 80,
          }}
          data-testid="upload-modal-backdrop"
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Upload a video"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(640px, 92vw)",
              maxHeight: "86vh",
              overflowY: "auto",
              background: "var(--paper)",
              borderRadius: "var(--r-3)",
              border: "1px solid var(--line)",
              padding: 22,
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
            data-testid="upload-modal"
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div className="label">Upload video</div>
                <h2 className="serif" style={{ fontSize: 22, marginTop: 2 }}>Two ways to send a lesson</h2>
              </div>
              <button
                type="button"
                aria-label="Close upload dialog"
                onClick={() => setOpen(false)}
                className="btn btn-sm"
                style={{ background: "transparent", borderColor: "var(--line)" }}
                data-testid="upload-modal-close"
              >
                ✕
              </button>
            </div>

            {/* Path 1 — WhatsApp (PRIMARY for teachers).
                Spec 169 — gated on assertEnv()'s GML_WHATSAPP_NUMBER
                check. When the env is invalid or unset the entire
                section is removed from the DOM (we do not render a
                stubbed disabled state); the direct-browser-upload
                section below remains the only path. */}
            {isUsableWhatsappPhone(whatsappPhone) ? (
            <section
              style={{
                border: "1px solid var(--line)",
                borderRadius: "var(--r-3)",
                padding: 14,
                background: "var(--card-hi)",
              }}
              data-testid="whatsapp-path"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="chip chip-lichen">Recommended</span>
                <h3 style={{ fontSize: 14, fontWeight: 600 }}>Send via WhatsApp</h3>
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
                The fastest path on a slow connection. Forward your video to the programme number with one of the
                caption codes below. It lands in this library automatically once the worker finishes transcoding.
              </p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 10,
                  padding: "8px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-2)",
                  background: "var(--paper)",
                }}
              >
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Programme WhatsApp</span>
                <span
                  className="mono"
                  style={{ fontSize: 13, fontWeight: 500, marginLeft: "auto" }}
                  data-testid="whatsapp-phone"
                >
                  {whatsappPhone ?? "—"}
                </span>
                <button
                  type="button"
                  onClick={onCopy}
                  disabled={!whatsappPhone}
                  className="btn btn-sm"
                  data-testid="copy-phone-button"
                >
                  {copyStatus === "copied" ? "Copied" : "Copy phone number"}
                </button>
              </div>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  marginTop: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  fontSize: 12,
                }}
              >
                <li>
                  Caption <code className="mono">OBS-&lt;code&gt;</code> — attaches to an observation cycle (code from the
                  cycle detail page).
                </li>
                <li>
                  {/* There is no "teach-back session": TB- names the RTT
                      subject taught back (uploads/context.ts), and the
                      subject's page is where a teacher is given it. */}
                  Caption <code className="mono">TB-&lt;subject&gt;</code> — a teach-back for an RTT subject (Upload a
                  teach-back video on the subject&apos;s page gives its code).
                </li>
                <li>
                  Caption <code className="mono">MM-&lt;uuid&gt;</code> — attaches to a mentor meeting.
                </li>
                <li>
                  Caption <code className="mono">Q1-&lt;uuid&gt;</code> or <code className="mono">Q4-&lt;uuid&gt;</code> —
                  a mentee&apos;s quarterly video for her pairing.
                </li>
              </ul>
              {/* This said a programme admin "can attach them from the WhatsApp
                  ingest log". No screen re-links a video; the log says so. */}
              <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}>
                A video whose caption has no code, or one you may not use, still arrives, but linked to nothing: only
                you and programme administrators can see it. Attach it from My uploads, or send it again with the
                right code.
              </p>
            </section>
            ) : null}

            {/* Path 2 — Direct browser upload */}
            <section data-testid="browser-path">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="chip">Admin / mentor</span>
                <h3 style={{ fontSize: 14, fontWeight: 600 }}>Or upload from this browser</h3>
              </div>
              <p
                style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6, marginBottom: 10 }}
                data-testid="upload-quality-explainer"
              >
                Resumable upload, MP4 / MOV / 3GP, transcodes to{" "}
                <strong>{videoDefaultQuality ?? "480p"} HLS</strong> after the upload finishes
                (set by the programme admin in system settings). Use this when you
                already have the file on disk (e.g. classroom recording).
              </p>
              {/* This tray is linked to nothing. A video for a cycle, a meeting or
                  a quarterly video belongs on /uploads, which asks what it is for
                  -- a generic one is invisible to the observer and mentor. */}
              <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0, marginBottom: 10 }}>
                Uploaded here, a video is linked to nothing: only you and programme administrators see it. For an
                observation cycle, a meeting or a quarterly video, use{" "}
                <Link href="/uploads" style={{ color: "var(--indigo)" }}>
                  My uploads
                </Link>
                , which asks what it is for.
              </p>
              <UploadProgress contextType="generic" onComplete={onUploadComplete} />
            </section>
          </div>
        </div>
      ) : null}
    </>
  );
}
