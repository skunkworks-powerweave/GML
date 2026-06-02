"use client";

// HLS video player with watermark overlay (SM-4 deterrence) and signed-URL refresh.
// Uses hls.js for browsers without native HLS support (most desktops, all Androids).
// Safari uses native HLS via the <video> src attribute.
//
// Spec 132 (Workflow Run 11 frontend-parity) — adds the speed + quality
// control row that the JSX prototype (LMS GML Frontend/videos.jsx lines
// 169-191) renders below the video. The prototype has 0.75× / 1× / 1.5×
// speed buttons + a 480p quality chip + a CC chip; we ship 1× / 1.25× /
// 1.5× / 2× (the four most-asked speeds from the demo dataset) and a
// quality dropdown with only Auto + 480p because spec 041 dropped the
// 720p ladder. The 720p row is rendered disabled with a tooltip so an
// operator who reads the source sees *why* it's gone.
//
// Speed controls live on `video.playbackRate` directly — hls.js streams
// that through to the underlying MediaSource without re-fetching the
// segment, so changing speed is instant and works on both the hls.js
// path and the Safari native-HLS path.
//
// Quality controls live on `hls.currentLevel`: -1 = auto-select per
// ABR algorithm, 0 = pin to the lowest level. Because spec 041 ships
// only a 480p rendition the practical effect is "Auto" and "480p" are
// the same stream; we still expose the toggle so the keyboard contract
// matches the prototype and so a future spec that re-enables 720p only
// needs to flip the disabled flag.

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

// Speed presets — match the prototype set with one tweak: drop the
// 0.75× option (rarely used on lesson video) and add 1.25× + 2× to
// cover the mentor "skim ahead" workflow.
const SPEED_PRESETS = [1, 1.25, 1.5, 2] as const;

export function HlsPlayer({ src, onRefresh, watermark, poster, videoId }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<{ destroy: () => void; currentLevel?: number } | null>(null);
  const [currentSrc, setCurrentSrc] = useState(src);
  const [error, setError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRateState] = useState<number>(1);
  const [quality, setQuality] = useState<"auto" | "480p">("auto");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hlsInstance: { destroy: () => void; currentLevel?: number } | undefined;

    const isNative = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (isNative) {
      video.src = currentSrc;
    } else {
      // Lazy-load hls.js so it doesn't bloat first paint.
      let cancelled = false;
      // Spec 156 (Run 14 audit-closure MEDIUM): chain a .catch so a
      // bundle-load failure surfaces as a user-visible error instead of a
      // silent black <video> element. Otherwise the dynamic import rejects,
      // nothing renders, and the user has no idea why the player is dead.
      import("hls.js")
        .then(({ default: Hls }) => {
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
          hlsRef.current = hls;
        })
        .catch((err) => {
          if (!cancelled) setError("Failed to load HLS player: " + String(err));
        });

      return () => {
        cancelled = true;
        hlsInstance?.destroy();
        hlsRef.current = null;
      };
    }
  }, [currentSrc, onRefresh]);

  // Apply playbackRate every time it changes. hls.js + native HLS both
  // honour the property without re-loading the stream.
  function applyPlaybackRate(rate: number) {
    setPlaybackRateState(rate);
    const v = videoRef.current;
    if (v) v.playbackRate = rate;
  }

  // Apply quality change. -1 = auto (ABR), 0 = pin to lowest level
  // (currently the only level, since spec 041 dropped 720p). On Safari
  // native HLS hlsRef is null and the choice is a no-op — the stream is
  // single-rendition anyway.
  function applyQuality(next: "auto" | "480p") {
    setQuality(next);
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = next === "auto" ? -1 : 0;
  }

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
    <div>
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

      {/* Player controls — speed + quality. JSX prototype lines 169-191. */}
      <div
        className="player-controls"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 10,
          fontSize: 12,
        }}
        data-testid="player-controls"
      >
        <span style={{ color: "var(--ink-3)", fontSize: 11 }}>Speed</span>
        <div style={{ display: "flex", gap: 4 }} role="group" aria-label="Playback speed">
          {SPEED_PRESETS.map((rate) => {
            const isActive = playbackRate === rate;
            return (
              <button
                key={rate}
                type="button"
                onClick={() => applyPlaybackRate(rate)}
                className="btn btn-sm"
                aria-pressed={isActive}
                data-testid={`speed-${rate}x`}
                style={{
                  background: isActive ? "var(--ink)" : "transparent",
                  color: isActive ? "var(--paper)" : "var(--ink-2)",
                  borderColor: isActive ? "var(--ink)" : "var(--line)",
                }}
              >
                {rate}×
              </button>
            );
          })}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <label htmlFor="hls-quality" style={{ color: "var(--ink-3)", fontSize: 11 }}>
            Quality
          </label>
          <select
            id="hls-quality"
            value={quality}
            onChange={(e) => applyQuality(e.target.value as "auto" | "480p")}
            className="btn btn-sm"
            data-testid="quality-select"
            style={{ padding: "2px 6px" }}
          >
            <option value="auto">Auto</option>
            <option value="480p">480p</option>
            <option value="720p" disabled title="720p disabled per programme settings">
              720p (disabled — spec 041)
            </option>
          </select>
        </div>
      </div>
    </div>
  );
}
