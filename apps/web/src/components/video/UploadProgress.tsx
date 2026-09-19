"use client";

// Direct browser upload tray. Used by /uploads, /videos and the observation
// cycle page.
//
// The bytes go STRAIGHT TO SUPABASE STORAGE over TUS; this application never
// sees them. What it does see is two short round-trips that bracket the
// transfer: `beginUploadAction` reserves the rows and issues an object key
// prefixed with the uploader's uuid, and `completeUploadAction` verifies the
// object actually landed at the reserved size before anything is queued.
//
// WHAT THIS REPLACED. The previous version posted to /api/uploads/tus, a proxy
// to a tusd sidecar. It uploaded nothing, ever: TUSD_INTERNAL_URL was set
// nowhere so every branch returned 501; tusd was pointed at a bucket that was
// never created; Caddy's route did not match the tus create request; and there
// were no post-finish hooks, so no rows were written and `source='direct'`
// submissions were unreachable. Its onSuccess handler read
// `upload.url?.split("/").pop() ?? "pending"` -- the tus upload id, or the
// literal string "pending" -- and passed that to onComplete as if it were a
// video_submissions id.

import { useRef, useState } from "react";
import { beginUploadAction, completeUploadAction } from "@/app/(authenticated)/uploads/actions";
import { startResumableUpload, type UploadHandle } from "@/lib/video/tus-upload";

type UploadProgressProps = {
  contextType:
    | "observation_cycle"
    | "teach_back"
    | "mentor_meeting"
    | "mentee_quarterly"
    | "classroom_session"
    | "generic";
  contextId?: string;
  onComplete?: (videoSubmissionId: string) => void;
};

type UploadState = {
  id: string;
  filename: string;
  bytes: number;
  bytesTotal: number;
  status: "uploading" | "transcoding" | "ready" | "failed";
  videoSubmissionId?: string;
  errorMessage?: string;
  handle?: UploadHandle;
};

export function UploadProgress({ contextType, contextId, onComplete }: UploadProgressProps) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function pickFile() {
    inputRef.current?.click();
  }

  function updateUpload(id: string, patch: Partial<UploadState>) {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    // crypto.randomUUID() rather than a clock read: two files chosen in the
    // same millisecond previously collided on this key.
    const id = `${crypto.randomUUID()}-${file.name}`;
    setUploads((prev) => [
      { id, filename: file.name, bytes: 0, bytesTotal: file.size, status: "uploading" },
      ...prev,
    ]);

    // 1. Reserve. The server checks that this user may attach a video to this
    //    context BEFORE anything is written -- contextId comes from the
    //    browser, and without that check a teacher could attach their upload
    //    into another teacher's observation cycle, which is a write into
    //    someone else's evidence rather than a read of it.
    const reservation = await beginUploadAction({
      filename: file.name,
      sizeBytes: file.size,
      contentType: file.type || "video/mp4",
      contextType,
      contextId: contextId ?? null,
    });
    if (!reservation.ok) {
      updateUpload(id, { status: "failed", errorMessage: reservation.error });
      return;
    }

    updateUpload(id, { videoSubmissionId: reservation.submissionId });

    // 2. Transfer, browser -> Storage.
    const handle = await startResumableUpload({
      file,
      bucket: reservation.bucket,
      objectKey: reservation.objectKey,
      chunkBytes: reservation.chunkBytes,
      // Server-supplied, not read from process.env in the browser -- see
      // lib/supabase/browser.ts.
      supabase: reservation.supabase,
      onProgress: (bytes, bytesTotal) => updateUpload(id, { bytes, bytesTotal }),
      onError: (message) => updateUpload(id, { status: "failed", errorMessage: message }),
      onSuccess: () => {
        updateUpload(id, { bytes: file.size, bytesTotal: file.size, status: "transcoding" });
        // 3. Tell the server. It verifies the object against the reserved size
        //    before queueing -- a client claiming completion having uploaded
        //    nothing would otherwise put an empty object into the pipeline,
        //    where it fails in the worker and looks like a transcoding problem.
        void completeUploadAction(reservation.submissionId).then((res) => {
          if (!res.ok) {
            updateUpload(id, { status: "failed", errorMessage: res.error });
            return;
          }
          onComplete?.(reservation.submissionId);
        });
      },
    });
    if (handle) updateUpload(id, { handle });
  }

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        background: "var(--card-hi)",
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={pickFile}
          style={{
            padding: "8px 14px",
            border: "1px solid var(--ink)",
            background: "var(--ink)",
            color: "var(--paper)",
            borderRadius: "var(--r-2)",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Upload video
        </button>
        <input ref={inputRef} type="file" accept="video/*" onChange={onFileChosen} style={{ display: "none" }} />
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
          MP4 / MOV / 3GP · resumable on network drop · 480p HLS transcode after upload
        </span>
      </div>

      {uploads.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {uploads.map((u) => {
            const pct = u.bytesTotal > 0 ? Math.round((u.bytes / u.bytesTotal) * 100) : 0;
            return (
              <li
                key={u.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 10,
                  padding: "8px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-2)",
                  fontSize: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>{u.filename}</div>
                  <div
                    style={{
                      height: 4,
                      borderRadius: 2,
                      background: "var(--paper-2)",
                      marginTop: 6,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        background:
                          u.status === "failed" ? "var(--rust)" : u.status === "ready" ? "var(--lichen)" : "var(--indigo)",
                        transition: "width 0.2s",
                      }}
                    />
                  </div>
                  {/* Spec 156: render the actionable error message inline so
                      the user sees WHY the upload failed and what to do next
                      (the WhatsApp PRIMARY path is the load-bearing fallback
                      for low-bandwidth Ladakh field mentors). */}
                  {u.status === "failed" && u.errorMessage ? (
                    <div
                      role="alert"
                      data-testid="upload-error-message"
                      style={{
                        marginTop: 6,
                        fontSize: 11,
                        color: "var(--rust)",
                        lineHeight: 1.45,
                      }}
                    >
                      {u.errorMessage}
                    </div>
                  ) : null}
                </div>
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--ink-3)",
                    alignSelf: "center",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {u.status === "uploading" ? `${pct}%` : u.status}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
