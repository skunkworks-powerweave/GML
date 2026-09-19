"use client";

// Last-resort boundary: catches faults in the ROOT layout itself, which
// error.tsx cannot -- error.tsx renders *inside* the layout that failed.
//
// This one replaces the whole document, so it must supply its own <html> and
// <body>. It also cannot rely on the app's fonts or globals.css, since the
// layout that loads them is precisely what failed; every style here is
// therefore inline. It should essentially never render. When it does, the
// deployment is broken rather than the page, so the copy points at the
// administrator instead of offering a retry that will fail identically.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          textAlign: "center",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: "#171717",
          background: "#fff",
        }}
        data-testid="global-error"
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>The application failed to load</h1>
        <p style={{ fontSize: 13, color: "#525252", margin: 0, maxWidth: 420 }}>
          This is a fault in the deployment itself, not in the page you requested. Please
          report it to your programme administrator.
        </p>
        {/* A plain anchor, not only the reset() button. Next prerenders this
            convention to a static _global-error.html, whose inline scripts
            carry no nonce and are therefore refused by the CSP proxy.ts
            issues -- so on the static shell React never hydrates and an
            onClick handler would do nothing at all. The link works with no
            JavaScript whatsoever, which is the only safe assumption on the
            page that renders when everything else has failed. */}
        <a
          href="/"
          style={{
            borderRadius: 6,
            background: "#171717",
            color: "#fff",
            padding: "8px 16px",
            fontSize: 13,
            textDecoration: "none",
          }}
        >
          Reload
        </a>
        <button
          type="button"
          onClick={reset}
          style={{
            border: "1px solid #d4d4d4",
            borderRadius: 6,
            background: "#fff",
            color: "#171717",
            padding: "8px 16px",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
        {error.digest ? (
          <p style={{ fontSize: 11, color: "#a3a3a3", margin: 0 }}>Reference {error.digest}</p>
        ) : null}
      </body>
    </html>
  );
}
