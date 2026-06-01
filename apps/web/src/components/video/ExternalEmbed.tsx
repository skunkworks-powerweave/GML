// Spec 044 — fallback embed for external video URLs (YouTube / Google Drive).
// Used when video_submissions.source === 'external_link'. No anti-download
// guarantees on this path; documented in the IT handover.

type ExternalEmbedProps = {
  url: string;
  watermark?: string;
};

export function ExternalEmbed({ url, watermark }: ExternalEmbedProps) {
  const kind = detectKind(url);
  const embedUrl = toEmbedUrl(url, kind);

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
      {embedUrl ? (
        <iframe
          src={embedUrl}
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          style={{ width: "100%", height: "100%", border: 0 }}
        />
      ) : (
        <div style={{ color: "var(--paper)", padding: 16, fontSize: 13 }}>
          Unsupported external URL. <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--saffron)" }}>Open in a new tab</a>.
        </div>
      )}

      {watermark ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            right: 12,
            top: 12,
            padding: "4px 8px",
            background: "rgba(0,0,0,0.45)",
            color: "rgba(255,255,255,0.85)",
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: "0.05em",
            borderRadius: "var(--r-2)",
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          {watermark}
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: 12,
          padding: "3px 7px",
          background: "rgba(0,0,0,0.55)",
          color: "var(--rust-soft)",
          fontFamily: "var(--mono)",
          fontSize: 9,
          borderRadius: "var(--r-1)",
          pointerEvents: "none",
        }}
      >
        external · not download-gated
      </div>
    </div>
  );
}

function detectKind(url: string): "youtube" | "drive" | "vimeo" | "unknown" {
  if (/youtube\.com|youtu\.be/.test(url)) return "youtube";
  if (/drive\.google\.com/.test(url)) return "drive";
  if (/vimeo\.com/.test(url)) return "vimeo";
  return "unknown";
}

function toEmbedUrl(url: string, kind: "youtube" | "drive" | "vimeo" | "unknown"): string | null {
  if (kind === "youtube") {
    const m = url.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/);
    if (m) return `https://www.youtube.com/embed/${m[1]}`;
  }
  if (kind === "drive") {
    const m = url.match(/\/file\/d\/([\w-]+)/);
    if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  }
  if (kind === "vimeo") {
    const m = url.match(/vimeo\.com\/(\d+)/);
    if (m) return `https://player.vimeo.com/video/${m[1]}`;
  }
  return null;
}
