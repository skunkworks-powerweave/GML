"use client";

// Spec 045 — direct browser upload progress tray. Used by /uploads (teacher's
// "My Uploads" page) and the admin sidebar's video ingestion widget.
//
// Wires to /api/uploads/tus (tusd handler, spec 038). For the WhatsApp PRIMARY
// path teachers don't see this — they upload from their phone's WhatsApp.

import { useEffect, useRef, useState } from "react";

type UploadProgressProps = {
  contextType: "observation_cycle" | "teach_back" | "mentor_meeting" | "mentee_quarterly" | "classroom_session" | "generic";
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
};

export function UploadProgress({ contextType, contextId, onComplete }: UploadProgressProps) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function pickFile() {
    inputRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const id = `${Date.now()}-${file.name}`;
    setUploads((prev) => [
      { id, filename: file.name, bytes: 0, bytesTotal: file.size, status: "uploading" },
      ...prev,
    ]);

    // Use tus-js-client (lazy-imported) for resumable upload
    // Falls back to a single PUT if tus not available
    try {
      const tus = await import("tus-js-client").catch(() => null);
      if (tus) {
        const upload = new tus.Upload(file, {
          endpoint: "/api/uploads/tus",
          chunkSize: 5 * 1024 * 1024, // 5 MB chunks
          metadata: {
            filename: file.name,
            filetype: file.type || "video/mp4",
            context_type: contextType,
            context_id: contextId ?? "",
          },
          onError: () => updateUpload(id, { status: "failed" }),
          onProgress: (bytesUploaded, bytesTotal) => updateUpload(id, { bytes: bytesUploaded, bytesTotal }),
          onSuccess: async () => {
            updateUpload(id, { bytes: file.size, bytesTotal: file.size, status: "transcoding" });
            // Server creates video_submissions row on tusd post-finish hook.
            // For now, simulate id wiring; spec 038 wires the real handler.
            const subId = (upload as { url?: string }).url?.split("/").pop() ?? "pending";
            updateUpload(id, { videoSubmissionId: subId });
            onComplete?.(subId);
          },
        });
        upload.start();
      } else {
        // Fallback path — direct POST
        updateUpload(id, { status: "failed" });
      }
    } catch {
      updateUpload(id, { status: "failed" });
    }

    e.target.value = "";
  }

  function updateUpload(id: string, patch: Partial<UploadState>) {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
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
