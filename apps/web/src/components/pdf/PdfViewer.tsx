"use client";

// PDF viewer with watermark overlay (SM-4 deterrence) + signed-URL streaming.
// We deliberately avoid pdfjs-dist (~3 MB of JS) — terrible for Ladakh bandwidth.
// Instead, we lean on the browser's native PDF plugin via <iframe>:
//   - The signed URL is a /api/media/<token> route minted server-side (5 min TTL).
//   - The iframe URL fragment `#toolbar=0&navpanes=0&scrollbar=0` hides Chrome /
//     Firefox / Edge's built-in download + print affordances. Not bullet-proof
//     (the user can still hit Ctrl+S on the iframe contents), but it removes
//     the obvious surface area.
//   - A diagonal repeating watermark <div> burns the viewer's email + the
//     "OBS-CONFIDENTIAL" tag into the viewport at mix-blend-mode: difference
//     so screenshots carry an identifying mark.
//   - onContextMenu is blocked on the wrapper so the right-click "Save as…"
//     entry doesn't appear over the iframe.
//
// SM-4 honesty: this is a deterrent, not DRM. The disclosure footer rendered
// by the parent server component states this plainly.

import { useEffect, useRef } from "react";

type PdfViewerProps = {
  /** Signed media URL — `/api/media/<token>`. Server mints with 5-min TTL. */
  src: string;
  /** Watermark text — typically `<user.email> · OBS-CONFIDENTIAL`. Required. */
  watermark: string;
  /** Resource id (used for the audit ping on first paint). */
  resourceId?: string;
};

export function PdfViewer({ src, watermark, resourceId }: PdfViewerProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Best-effort audit ping for the *client* paint (the server already audits
  // on page load — this is a second signal that the viewer actually rendered).
  useEffect(() => {
    if (!resourceId) return;
    void fetch(`/api/audit/resource-view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: resourceId }),
      keepalive: true,
    }).catch(() => undefined);
  }, [resourceId]);

  // Build the diagonal repeating watermark text — long enough to tile the
  // viewport without showing seams at common viewer sizes.
  const tileText = `${watermark}    `.repeat(6);

  return (
    <div
      ref={wrapperRef}
      data-testid="pdf-viewer-wrapper"
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "relative",
        width: "100%",
        height: "min(78vh, 980px)",
        background: "#1c1816",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
        border: "1px solid var(--line)",
      }}
    >
      {/* Native browser PDF viewer. Toolbar / navpanes / scrollbar hidden via fragment. */}
      <iframe
        title="PDF document viewer"
        src={`${src}#toolbar=0&navpanes=0&scrollbar=0`}
        style={{
          width: "100%",
          height: "100%",
          border: 0,
          background: "#fff",
        }}
      />

      {/* Diagonal repeating watermark overlay — burns user identity into screenshots. */}
      <div
        aria-hidden
        data-testid="pdf-watermark-overlay"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          userSelect: "none",
          opacity: 0.15,
          mixBlendMode: "difference",
          color: "#1c1816",
          fontFamily: "var(--mono)",
          fontSize: 13,
          letterSpacing: "0.05em",
          lineHeight: 2.6,
          whiteSpace: "nowrap",
          transform: "rotate(-28deg) scale(1.6)",
          transformOrigin: "center center",
          overflow: "hidden",
          textAlign: "center",
        }}
      >
        {Array.from({ length: 14 }).map((_, i) => (
          <div key={i}>{tileText}</div>
        ))}
      </div>

      {/* Top-right "watermark tag" badge — mirrors HlsPlayer's tag for consistency. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: 12,
          top: 12,
          padding: "4px 8px",
          background: "rgba(28, 24, 22, 0.55)",
          color: "rgba(246, 241, 230, 0.9)",
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: "0.05em",
          borderRadius: "var(--r-2)",
          pointerEvents: "none",
          userSelect: "none",
          zIndex: 2,
        }}
      >
        {watermark}
      </div>
    </div>
  );
}
