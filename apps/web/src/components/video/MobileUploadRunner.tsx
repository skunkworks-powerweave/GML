"use client";

// Spec 135 (Workflow Run 12 — final frontend-parity) — mobile upload runner.
//
// JSX prototype reference: LMS GML Frontend/mobile-runners.jsx::MobUpload
// (lines 181-294). The desktop /uploads page already renders three explainer
// cards + an inline <UploadProgress /> tray (spec 045). On a phone-sized
// viewport the same affordance is wrong: teachers expect a full-screen flow
// with two enormous buttons (Record / Pick), a Preview screen for caption
// hinting, then a single full-bleed progress screen with the WhatsApp
// fallback reminder.
//
// The runner is a thin sibling of UploadProgress — it reuses the *same*
// tus-js-client endpoint (/api/uploads/tus, spec 038) and chunk size so the
// pipeline downstream of the browser is identical. The differences are
// purely UX:
//
//   1. The "Record now" button uses `capture="environment"` on a hidden
//      file input so iOS/Android open the camera roll's record sheet
//      directly. Falls back to a regular file picker if `capture` is
//      ignored (older browsers).
//   2. The "Pick from gallery" button is a separate input with no
//      `capture` attribute so the OS gallery picker opens instead.
//   3. After a file is chosen we render a Preview frame extracted from the
//      first decoded frame of the video (drawn on a hidden canvas) — gives
//      the teacher a recognisable thumbnail before they commit to upload.
//   4. The caption textarea is the teacher's chance to say what the clip is.
//      It is POSTED, on completion, through completeUploadAction, and is kept
//      on the submission (and, for a cycle, on the observation_evidence row the
//      cycle page renders).
//
//      It previously went nowhere at all. The comment here said so plainly --
//      "We do NOT post the caption anywhere" -- and reasoned that the webhook
//      ingest worker would strip it back out of the filename. That worker
//      handles the WHATSAPP path; a direct upload never touches it. So the
//      screen asked a teacher on a phone to "add a caption so your mentor knows
//      what this is", and then discarded what she typed.
//   5. The upload screen shows the WhatsApp PRIMARY-path reminder as a
//      bottom card so a teacher on a slow link can bail to wa.me/<phone>
//      mid-upload without losing the file (it stays on disk).
//   6. On success we redirect to /uploads so the teacher lands on their
//      My Uploads grid and sees the new row.
//
// Touch-target rules (Apple HIG / Material Design): the two main "Record"
// and "Pick" tiles are 56px tall (≥ 44 minimum), the cancel + start-upload
// buttons are 48px tall, and the file inputs are visually hidden but
// activated via the tiles so the hit area is the full card.
//
// Safe-area: the runner respects env(safe-area-inset-bottom) so the
// Start-upload sticky CTA on iOS doesn't hide under the home indicator.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { beginUploadAction, completeUploadAction } from "@/app/(authenticated)/uploads/actions";
import { startResumableUpload } from "@/lib/video/tus-upload";
import { confirmUpload } from "@/lib/video/confirm-upload";

type MobileUploadRunnerProps = {
  /** Programme WhatsApp number (E.164, no +) for the fallback reminder.
   *  Same env-var contract as UploadModal (spec 132). */
  whatsappPhone?: string | null;
  /**
   * What the video is for, as the /uploads page resolved and authorised it.
   * Unset means 'generic': linked to nothing, visible to the uploader and
   * administrators only.
   *
   * This replaced `activeCycleCode`, which no page passed and which could not
   * have worked: it sent the cycle's CODE where the server expects its id (a
   * 404 at reservation), prefilled the caption as `OBS-${code}` --
   * OBS-OBS-2026-004, since codes are stored with their prefix -- and WhatsApp
   * with `#${code}`.
   */
  target?: ResolvedUploadTarget | null;
};

export type ResolvedUploadTarget = {
  contextType: "observation_cycle" | "teach_back" | "mentor_meeting" | "mentee_quarterly" | "classroom_session" | "generic";
  contextId: string | null;
  quarter: 1 | 4 | null;
  /** What WhatsApp should carry as the caption to reach the same place; null when it cannot. */
  whatsappText: string | null;
};

type Step = "choose" | "preview" | "uploading" | "done" | "failed";

// Module-level so the governance test can pin the contract without parsing
// JSX trees. Each tile is a deterministic full-bleed primary action.
export const MOBILE_TILES = [
  {
    id: "record",
    label: "Record now",
    sub: "Opens your phone camera",
    capture: "environment" as const,
    accent: "var(--rust)",
  },
  {
    id: "pick",
    label: "Pick from gallery",
    sub: "Choose a video file",
    capture: null,
    accent: "var(--indigo)",
  },
] as const;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Pulls a single frame from the chosen video as a data: URL for the
// preview thumbnail. Resolves to null when the codec/container is one
// the browser cannot decode (e.g. some 3GP variants).
async function extractFirstFrame(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    };

    video.onloadedmetadata = () => {
      // Seek a hair past 0 so we land on a real I-frame (some codecs
      // return a black frame at exactly 0).
      video.currentTime = Math.min(0.5, video.duration / 4 || 0);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(320, video.videoWidth || 320);
        canvas.height = Math.round(
          canvas.width * ((video.videoHeight || 180) / (video.videoWidth || 320)),
        );
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          resolve(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/jpeg", 0.65);
        cleanup();
        resolve(data);
      } catch {
        cleanup();
        resolve(null);
      }
    };
    video.onerror = () => {
      cleanup();
      resolve(null);
    };
  });
}

export function MobileUploadRunner({
  whatsappPhone,
  target,
}: MobileUploadRunnerProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("choose");
  const [file, setFile] = useState<File | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  // A note for whoever reviews the video, not a routing code: `target` decides
  // where a direct upload goes.
  const [caption, setCaption] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Two refs so the OS can distinguish "open camera" vs "open gallery"
  // (the `capture` attribute is opt-in per input).
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  // Hold a reference to the live tus upload so Cancel can abort it.
  const uploadRef = useRef<{ abort: () => void } | null>(null);
  // Spec 149 (Workflow Run 13 audit closure) — distinguish a user-driven
  // cancel (which keeps the redirect timer scheduled is meaningless since
  // we never reached onSuccess) from an unmount-driven abort (which MUST
  // suppress the success-redirect AND surface a visible error so the user
  // doesn't see a frozen progress bar with no explanation). The mounted
  // ref drives both the unmount-abort error message and the redirect
  // cancellation token below.
  const mountedRef = useRef(true);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The submission whose bytes are stored but whose completion the server has
  // not confirmed. While set, Retry confirms it again instead of re-uploading.
  // It belongs to that one upload: going Back, choosing a file, cancelling or
  // starting an upload clears it, or a Retry of a LATER file's failure would
  // confirm this one and report "Uploaded" for a file never sent. Abandoned,
  // it is not lost: the reconciler finishes a stored upload whose completion
  // never came.
  const unconfirmedRef = useRef<string | null>(null);

  function openPicker(id: string) {
    if (id === "record") cameraRef.current?.click();
    else galleryRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    unconfirmedRef.current = null;
    setFile(f);
    setStep("preview");
    setThumb(null);
    const t = await extractFirstFrame(f);
    setThumb(t);
    // Reset input so the same file can be picked again after cancel.
    e.target.value = "";
  }

  async function startUpload() {
    if (!file) return;
    unconfirmedRef.current = null;
    setStep("uploading");
    setProgress(0);
    setErrorMsg(null);

    try {
      // Reserve first. The server authorizes the context and issues an object
      // key prefixed with this user's uuid; the bytes then go straight to
      // Supabase Storage without passing through the application.
      const reservation = await beginUploadAction({
        filename: file.name,
        sizeBytes: file.size,
        contentType: file.type || "video/mp4",
        contextType: target?.contextType ?? "generic",
        contextId: target?.contextId ?? null,
        quarter: target?.quarter ?? null,
      });
      if (!reservation.ok) {
        if (!mountedRef.current) return;
        setErrorMsg(reservation.error);
        setStep("failed");
        return;
      }

      const handle = await startResumableUpload({
        file,
        bucket: reservation.bucket,
        objectKey: reservation.objectKey,
        chunkBytes: reservation.chunkBytes,
        // Server-supplied, not read from process.env in the browser -- see
        // lib/supabase/browser.ts.
        supabase: reservation.supabase,
        onError: (message) => {
          // Spec 149 — an error after unmount must NOT setState: React warns
          // and the error UI never reaches a user anyway. The cleanup in
          // useEffect has already torn the upload down.
          if (!mountedRef.current) return;
          setErrorMsg(message);
          setStep("failed");
        },
        onProgress: (bytesUploaded: number, bytesTotal: number) => {
          if (!mountedRef.current) return;
          setProgress(bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 0);
        },
        onSuccess: () => {
          if (!mountedRef.current) return;
          setProgress(100);
          void confirm(reservation.submissionId);
        },
      });
      uploadRef.current = handle;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      setErrorMsg(msg);
      setStep("failed");
    }
  }

  // Confirm server-side before claiming success. The old code declared done
  // the moment tus finished, with no row written anywhere. The caption travels
  // with the completion, not the filename.
  //
  // This was `void completeUploadAction(...).then(...)` with no catch: a
  // dropped connection on that last POST left the screen at 100% for good,
  // and the only Retry restarted the whole upload of a file already stored.
  // A network failure is now retried (lib/video/confirm-upload), then shown,
  // and Retry confirms again.
  async function confirm(submissionId: string) {
    const res = await confirmUpload(() => completeUploadAction(submissionId, caption));
    if (!mountedRef.current) return;
    if (!res.ok) {
      unconfirmedRef.current = res.retryable ? submissionId : null;
      setErrorMsg(res.error);
      setStep("failed");
      return;
    }
    unconfirmedRef.current = null;
    setStep("done");
    // Spec 149 — hold the redirect behind mountedRef and a stored
    // timer handle so an unmount between completion and the delay
    // cancels it, and a router teardown surfaces a retry rather than
    // leaving the user on a dead success screen.
    redirectTimerRef.current = setTimeout(() => {
      redirectTimerRef.current = null;
      if (!mountedRef.current) return;
      try {
        router.push("/uploads");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Redirect failed";
        setErrorMsg(`${msg} — tap Back to return to My Uploads`);
        setStep("failed");
      }
    }, 1200);
  }

  function retry() {
    const pending = unconfirmedRef.current;
    if (!pending) return void startUpload();
    setStep("uploading");
    setErrorMsg(null);
    void confirm(pending);
  }

  function cancelUpload() {
    uploadRef.current?.abort();
    uploadRef.current = null;
    unconfirmedRef.current = null;
    setStep("choose");
    setFile(null);
    setThumb(null);
    setProgress(0);
  }

  // Spec 149 (Workflow Run 13 audit closure) — unmount cleanup MUST:
  //   1. Mark the component as unmounted FIRST so any in-flight tus
  //      callbacks (onError / onProgress / onSuccess) skip their setState
  //      branches (see mountedRef guards above).
  //   2. Cancel the pending redirect timer so we don't router.push on an
  //      unmounted component (React would log a warning and the navigation
  //      would race the user's next click).
  //   3. Surface an "Upload cancelled — try again" error message before
  //      tearing the upload down. The previous implementation silently
  //      aborted the tus instance, leaving the user staring at a stalled
  //      progress bar on remount with no explanation of why their video
  //      didn't reach the server. setState during unmount is fine here
  //      because StrictMode's double-mount cycle re-runs the effect; the
  //      sibling render reads the error from the same state slot.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Step 1 — flip the mount flag so tus callbacks see "unmounted" and
      // skip their setState branches.
      mountedRef.current = false;
      // Step 2 — cancel the pending success-redirect timer.
      if (redirectTimerRef.current) {
        clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
      // Step 3 — surface a visible error so a remount or a parent-tracked
      // error sink can read it. Guarded: if there's no live upload, the
      // unmount is a clean teardown (e.g. user already pressed Cancel and
      // we're navigating away) and we leave the error state alone.
      if (uploadRef.current) {
        setErrorMsg("Upload cancelled — try again");
        uploadRef.current.abort();
        uploadRef.current = null;
      }
    };
  }, []);

  // wa.me takes the number as digits only; "+91..." is not a valid path there.
  // The pre-fill is the caption the webhook reads: the target's own code
  // (OBS-2026-009, MM-<meeting>), or the "OBS-" prefix for the teacher to
  // finish. "#cycle-" was never recognised. No link at all for a target
  // WhatsApp cannot reach: the video would arrive linked to nothing.
  const waDigits = whatsappPhone ? whatsappPhone.replace(/[^0-9]/g, "") : "";
  const waText = target ? target.whatsappText : "OBS-";
  const waHref =
    waDigits && waText !== null ? `https://wa.me/${waDigits}?text=${encodeURIComponent(waText)}` : null;

  return (
    <div
      data-testid="mobile-upload-runner"
      // What a reservation from this flow is for, readable from the markup
      // (as on UploadProgress).
      data-upload-context={target?.contextType ?? "generic"}
      data-upload-context-id={target?.contextId ?? ""}
      data-upload-quarter={target?.quarter ?? ""}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "calc(100dvh - 120px)",
        paddingTop: "env(safe-area-inset-top, 0)",
        paddingBottom: "calc(16px + env(safe-area-inset-bottom, 0))",
        paddingLeft: "max(16px, env(safe-area-inset-left, 0))",
        paddingRight: "max(16px, env(safe-area-inset-right, 0))",
      }}
    >
      {/* Hidden file inputs — the visible tiles delegate clicks to these
          via openPicker(). Two inputs are needed because `capture` is
          per-input on iOS/Android. */}
      <input
        ref={cameraRef}
        type="file"
        accept="video/*"
        capture="environment"
        onChange={onFileChosen}
        style={{ display: "none" }}
        data-testid="camera-input"
      />
      <input
        ref={galleryRef}
        type="file"
        accept="video/*"
        onChange={onFileChosen}
        style={{ display: "none" }}
        data-testid="gallery-input"
      />

      {step === "choose" ? (
        <>
          <div style={{ marginBottom: 18 }}>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 24, margin: 0 }}>
              Submit a lesson video
            </h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 6 }}>
              Pick a way that fits your network today.
            </p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {MOBILE_TILES.map((tile) => (
              <button
                key={tile.id}
                type="button"
                onClick={() => openPicker(tile.id)}
                data-testid={`tile-${tile.id}`}
                style={{
                  minHeight: 56,
                  padding: "16px 18px",
                  borderRadius: 14,
                  border: "1px solid var(--line)",
                  background: "var(--card)",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 12,
                    background: tile.accent,
                    color: "white",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}
                >
                  {tile.id === "record" ? "REC" : "PIC"}
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 16, fontWeight: 600 }}>
                    {tile.label}
                  </span>
                  <span
                    style={{ display: "block", fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}
                  >
                    {tile.sub}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* WhatsApp PRIMARY-path reminder card. Lichen-soft to read as
              "this is the recommended path on a slow link". */}
          <div
            style={{
              marginTop: 20,
              padding: 14,
              borderRadius: 12,
              background: "var(--lichen-soft)",
              border: "1px solid oklch(0.82 0.06 145)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              On a slow 2G/3G link?
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>
              WhatsApp is faster than direct upload on weak signals — your phone
              keeps retrying in the background.
            </p>
            {waHref ? (
              <a
                href={waHref}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="whatsapp-fallback-link"
                style={{
                  display: "inline-block",
                  marginTop: 10,
                  minHeight: 44,
                  padding: "10px 16px",
                  borderRadius: 10,
                  background: "var(--lichen)",
                  color: "white",
                  fontWeight: 500,
                  fontSize: 14,
                  textDecoration: "none",
                }}
              >
                Open WhatsApp
              </a>
            ) : null}
          </div>
        </>
      ) : null}

      {step === "preview" && file ? (
        <>
          <div style={{ marginBottom: 14 }}>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: 0 }}>
              Looks good?
            </h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
              Add a caption so your mentor knows what this is.
            </p>
          </div>

          <div
            style={{
              borderRadius: 12,
              overflow: "hidden",
              border: "1px solid var(--line)",
              background: "var(--paper-2)",
              aspectRatio: "16 / 9",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumb}
                alt="First frame of selected video"
                data-testid="preview-thumb"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Preview unavailable (codec not browser-decodable)
              </span>
            )}
          </div>

          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: "var(--ink-3)",
              fontFamily: "var(--mono)",
            }}
          >
            {file.name} · {humanSize(file.size)}
          </div>

          <label
            htmlFor="mobile-upload-caption"
            style={{
              display: "block",
              marginTop: 16,
              fontSize: 12,
              color: "var(--ink-2)",
              fontWeight: 500,
            }}
          >
            {/* This said "Caption — use OBS-<cycle>, TB-<uuid> or MM-<uuid>".
                A direct upload is never routed by its caption -- the page's
                target decides -- so following it achieved nothing. */}
            Note for whoever reviews it (optional)
          </label>
          <textarea
            id="mobile-upload-caption"
            data-testid="caption-textarea"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="What the lesson was about"
            rows={3}
            style={{
              width: "100%",
              marginTop: 6,
              padding: 12,
              fontSize: 15,
              borderRadius: 10,
              border: "1px solid var(--line)",
              fontFamily: "var(--mono)",
              background: "var(--paper)",
              resize: "vertical",
              minHeight: 72,
            }}
          />

          <div style={{ flex: 1 }} />

          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button
              type="button"
              onClick={cancelUpload}
              data-testid="preview-cancel"
              style={{
                minHeight: 48,
                padding: "12px 18px",
                borderRadius: 10,
                border: "1px solid var(--line)",
                background: "var(--card)",
                color: "var(--ink)",
                fontSize: 14,
                fontWeight: 500,
                flex: 1,
              }}
            >
              Back
            </button>
            <button
              type="button"
              onClick={startUpload}
              data-testid="start-upload"
              style={{
                minHeight: 48,
                padding: "12px 18px",
                borderRadius: 10,
                border: "1px solid var(--ink)",
                background: "var(--ink)",
                color: "var(--paper)",
                fontSize: 15,
                fontWeight: 600,
                flex: 2,
              }}
            >
              Start upload
            </button>
          </div>
        </>
      ) : null}

      {step === "uploading" && file ? (
        <>
          <div style={{ marginBottom: 18 }}>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: 0 }}>
              Uploading…
            </h1>
            <p
              style={{
                color: "var(--ink-3)",
                fontSize: 12,
                marginTop: 4,
                fontFamily: "var(--mono)",
              }}
            >
              {file.name} · {humanSize(file.size)}
            </p>
          </div>

          <div
            data-testid="progress-bar"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              height: 12,
              borderRadius: 6,
              background: "var(--paper-2)",
              overflow: "hidden",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: "var(--indigo)",
                transition: "width 0.25s",
              }}
            />
          </div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 13,
              color: "var(--ink-2)",
              textAlign: "right",
            }}
          >
            {progress}%
          </div>

          <div
            style={{
              marginTop: 18,
              padding: 14,
              borderRadius: 12,
              border: "1px solid var(--line)",
              background: "var(--card)",
              fontSize: 12,
              color: "var(--ink-3)",
              lineHeight: 1.6,
            }}
          >
            Whoever plays your video back sees their own name and the time over
            it — please do not redistribute outside the programme.
          </div>

          {waHref ? (
            <div
              style={{
                marginTop: 14,
                padding: 14,
                borderRadius: 12,
                background: "var(--lichen-soft)",
                border: "1px solid oklch(0.82 0.06 145)",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                If your connection is slow, send via WhatsApp instead
              </div>
              <a
                href={waHref}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="whatsapp-fallback-link"
                style={{
                  display: "inline-block",
                  marginTop: 8,
                  fontSize: 13,
                  color: "var(--lichen)",
                  fontFamily: "var(--mono)",
                }}
              >
                wa.me/{waDigits}
              </a>
            </div>
          ) : null}

          <div style={{ flex: 1 }} />

          <button
            type="button"
            onClick={cancelUpload}
            data-testid="cancel-upload"
            style={{
              minHeight: 48,
              padding: "12px 18px",
              borderRadius: 10,
              border: "1px solid var(--line)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: 14,
              fontWeight: 500,
              marginTop: 18,
            }}
          >
            Cancel
          </button>
        </>
      ) : null}

      {step === "done" ? (
        <div
          style={{
            textAlign: "center",
            paddingTop: 48,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div
            aria-hidden
            style={{
              width: 76,
              height: 76,
              borderRadius: "50%",
              background: "var(--lichen)",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 32,
              fontWeight: 700,
            }}
          >
            ✓
          </div>
          <div style={{ fontFamily: "var(--serif)", fontSize: 22, marginTop: 18 }}>
            Uploaded
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>
            {/* This promised "We'll notify your mentor when it's ready": nothing
                notifies anyone when a transcode finishes. */}
            Transcoding now. It can be played once that has finished.
            Taking you to My Uploads…
          </p>
        </div>
      ) : null}

      {step === "failed" ? (
        <>
          <div style={{ marginBottom: 18 }}>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: 0 }}>
              Upload failed
            </h1>
            <p style={{ color: "var(--rust)", fontSize: 13, marginTop: 6 }}>
              {errorMsg ?? "Something went wrong. Try again or use WhatsApp."}
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={() => {
                unconfirmedRef.current = null;
                setStep("choose");
              }}
              style={{
                minHeight: 48,
                padding: "12px 18px",
                borderRadius: 10,
                border: "1px solid var(--line)",
                background: "var(--card)",
                color: "var(--ink)",
                fontSize: 14,
                fontWeight: 500,
                flex: 1,
              }}
            >
              Back
            </button>
            {file ? (
              <button
                type="button"
                onClick={retry}
                style={{
                  minHeight: 48,
                  padding: "12px 18px",
                  borderRadius: 10,
                  border: "1px solid var(--ink)",
                  background: "var(--ink)",
                  color: "var(--paper)",
                  fontSize: 15,
                  fontWeight: 600,
                  flex: 1,
                }}
              >
                Retry
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
