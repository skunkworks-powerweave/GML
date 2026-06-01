"use client";

// HLS video player with watermark overlay (SM-4 deterrence) and signed-URL refresh.
// Uses hls.js for browsers without native HLS support (most desktops, all Androids).
// Safari uses native HLS via the <video> src attribute.

import { useEffect, useRef, useState } from "react";

type HlsPlayerProps = {
  /** Pre-signed master playlist URL — /api/media/<token>. Refresh from server before expiry. */
  src: string;
  /** Refresh fn called when the token nears expiry. Server returns a new signed URL. */
  onRefresh?: () => Promise<string>;
  /** Watermark text (e.g. "Dr. Anjali Bhatt · 2026-05-20 16:48"). Required for SM-4 compliance. */
  watermark: string;
  /** Poster URL (signed). Optional. */
  poster?: string;
  /** Track ID for audit; emitted on play/pause events. */
  videoId?: string;
};

export function HlsPlayer({ src, onRefresh, watermark, poster, videoId }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentSrc, setCurrentSrc] = useState(src);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hlsInstance: { destroy: () => void } | undefined;

    const isNative = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (isNative) {
      video.src = currentSrc;
    } else {
      // Lazy-load hls.js so it doesn't bloat first paint.
      let cancelled = false;
      import("hls.js").then(({ default: Hls }) => {
        if (cancelled || !Hls.isSupported()) {
          if (!cancelled) setError("HLS playback not supported in this browser.");
          return;
        }
        const hls = new Hls({
          // Low-bandwidth-friendly defaults
          maxBufferLength: 30,
          backBufferLength: 30,
          lowLatencyMode: false,
        });
        hls.loadSource(currentSrc);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, async (_e, data) => {
          if (!data.fatal) return;
          // Signed URL likely expired — try refresh once
          if (onRefresh) {
            try {
              const next = await onRefresh();
              setCurrentSrc(next);
            } catch {
              setError("Playback failed. Refresh the page.");
            }
          } else {
            setError(`Playback error: ${data.type}`);
          }
        });
        hlsInstance = hls;
      });

      return () => {
        cancelled = true;
        hlsInstance?.destroy();
      };
    }
  }, [currentSrc, onRefresh]);

  // Emit audit events (the server records `video.play`/`video.pause`)
  function logEvent(kind: "play" | "pause" | "ended") {
    if (!videoId) return;
    void fetch(`/api/videos/${encodeURIComponent(videoId)}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, t: videoRef.current?.currentTime ?? 0 }),
      keepalive: true,
    }).catch(() => undefined);
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 9",
        background: "#000",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        controls
        playsInline
        poster={poster}
        onPlay={() => logEvent("play")}
        onPause={() => logEvent("pause")}
        onEnded={() => logEvent("ended")}
        style={{
          width: "100%",
          height: "100%",
          background: "#000",
          // Block right-click on the <video> element itself
          pointerEvents: "auto",
        }}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Watermark overlay — user · timestamp burned into the viewport (SM-4 deterrence) */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: 12,
          top: 12,
          padding: "4px 8px",
          background: "rgba(0, 0, 0, 0.45)",
          color: "rgba(255, 255, 255, 0.85)",
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: "0.05em",
          borderRadius: "var(--r-2)",
          mixBlendMode: "screen",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {watermark}
      </div>

      {error ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--paper)",
            background: "rgba(0,0,0,0.7)",
            fontSize: 13,
            padding: 16,
            textAlign: "center",
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
