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
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  // lang="en" is deliberate and correct HERE, unlike the root layout it
  // replaces: every string on this page is hardcoded English (it cannot load
  // the message bundles -- the layout that provides them is what failed), and
  // lang describes the language of the content. It is also prerendered to a
  // static _global-error.html, so it cannot read the locale cookie at render
  // time without a hydration mismatch on the one page that must not fail.
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
        {/* A plain anchor, not only the Try again button. Next prerenders this
            convention to a static _global-error.html, whose inline scripts
            carry no nonce and are therefore refused by the CSP proxy.ts
            issues -- so on the static shell React never hydrates and an
            onClick handler would do nothing at all. The link works with no
            JavaScript whatsoever, which is the only safe assumption on the
            page that renders when everything else has failed. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
            A plain <a> is deliberate and <Link> would be wrong here. This
            boundary catches a fault in the ROOT LAYOUT, replaces the entire
            document, and is prerendered to a static _global-error.html whose
            inline scripts carry no CSP nonce -- so React does not hydrate and
            the client router this component would need may not exist at all.
            A full page load is the only navigation that can be relied on at
            this point. */}
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
        {/* unstable_retry, not reset: reset re-renders the payload that just
            failed without asking the server again. Where React has hydrated,
            this refreshes and re-renders the root; on the static shell above
            the link is what works. */}
        <button
          type="button"
          onClick={() => unstable_retry()}
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
