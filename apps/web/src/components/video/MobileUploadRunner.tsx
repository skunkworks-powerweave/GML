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
//   4. The caption textarea is the teacher's chance to type OBS- / TB- /
//      MM- code. We do NOT post the caption anywhere (the tus metadata
//      contract is fixed); we just store it in component state and prefix
//      the filename when sending. The webhook ingest worker (spec 043)
//      strips the caption back out on completion.
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

type MobileUploadRunnerProps = {
  /** Programme WhatsApp number (E.164, no +) for the fallback reminder.
   *  Same env-var contract as UploadModal (spec 132). */
  whatsappPhone?: string | null;
  /** Optional active observation cycle code to prefill the caption
   *  ("OBS-c2026-004"). When unset the caption starts blank. */
  activeCycleCode?: string | null;
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
  activeCycleCode,
}: MobileUploadRunnerProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("choose");
  const [file, setFile] = useState<File | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [caption, setCaption] = useState<string>(
    activeCycleCode ? `OBS-${activeCycleCode}` : "",
  );
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Two refs so the OS can distinguish "open camera" vs "open gallery"
  // (the `capture` attribute is opt-in per input).
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  // Hold a reference to the live tus upload so Cancel can abort it.
  const uploadRef = useRef<{ abort: () => void } | null>(null);

  function openPicker(id: string) {
    if (id === "record") cameraRef.current?.click();
    else galleryRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
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
    setStep("uploading");
    setProgress(0);
    setErrorMsg(null);

    try {
      const tus = await import("tus-js-client").catch(() => null);
      if (!tus) {
        setErrorMsg("Upload library failed to load. Try WhatsApp instead.");
        setStep("failed");
        return;
      }
      const upload = new tus.Upload(file, {
        endpoint: "/api/uploads/tus",
        chunkSize: 5 * 1024 * 1024,
        metadata: {
          filename: file.name,
          filetype: file.type || "video/mp4",
          context_type: activeCycleCode ? "observation_cycle" : "generic",
          context_id: activeCycleCode ?? "",
          caption: caption.trim(),
        },
        onError: (err: Error) => {
          setErrorMsg(err.message || "Upload failed");
          setStep("failed");
        },
        onProgress: (bytesUploaded: number, bytesTotal: number) => {
          const pct = bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 0;
          setProgress(pct);
        },
        onSuccess: () => {
          setProgress(100);
          setStep("done");
          // Give the success screen a beat so the user sees confirmation
          // before we boot them out to the listing page.
          window.setTimeout(() => router.push("/uploads"), 1200);
        },
      });
      uploadRef.current = upload;
      upload.start();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      setErrorMsg(msg);
      setStep("failed");
    }
  }

  function cancelUpload() {
    uploadRef.current?.abort();
    uploadRef.current = null;
    setStep("choose");
    setFile(null);
    setThumb(null);
    setProgress(0);
  }

  // If the user navigates away mid-upload we abort the tus instance so we
  // don't leak a hanging XHR.
  useEffect(() => {
    return () => {
      uploadRef.current?.abort();
    };
  }, []);

  const waHref = whatsappPhone
    ? `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(
        activeCycleCode ? `#${activeCycleCode}` : "#cycle-",
      )}`
    : null;

  return (
    <div
      data-testid="mobile-upload-runner"
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
            Caption — use OBS-&lt;cycle&gt;, TB-&lt;uuid&gt; or MM-&lt;uuid&gt;
          </label>
          <textarea
            id="mobile-upload-caption"
            data-testid="caption-textarea"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="OBS-c2026-004"
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
            Your video will be watermarked with the viewer's name + email when
            it is played back — please do not redistribute outside the
            programme.
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
                wa.me/{whatsappPhone}
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
            Transcoding now. We'll notify your mentor when it's ready (≈ 5 min).
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
              onClick={() => setStep("choose")}
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
                onClick={startUpload}
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
