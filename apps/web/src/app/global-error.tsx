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
//
// IN ALL THREE LANGUAGES AT ONCE. It cannot load the message bundles (the
// layout that provides them is what failed, and importing them here would ship
// every string of the interface to every client) and it cannot know the
// reader's language (it is prerendered to a static _global-error.html, with no
// cookie and no session). So it carries its own few lines in English, Hindi
// and Bhoti, each marked with its language, and shows all three. They were
// English only, which on the one page that must not fail left a Hindi or
// Bhoti reader with nothing they could read.

type Copy = { title: string; body: string; reload: string; retry: string; reference: string };

// Written here, not read from a bundle: see above. Hindi and Bhoti follow
// docs/i18n-glossary.md (machine-drafted, awaiting native review like the
// bundles).
const COPY: Array<{ lang: "en" | "hi" | "bo"; fontFamily?: string; copy: Copy }> = [
  {
    lang: "en",
    copy: {
      // i18n-ignore: global-error cannot load bundles; its en/hi/bo copy is written here
      title: "The application failed to load",
      // i18n-ignore: global-error cannot load bundles; its en/hi/bo copy is written here
      body: "This is a fault in the deployment itself, not in the page you requested. Please report it to your programme administrator.",
      reload: "Reload",
      // i18n-ignore: global-error cannot load bundles; its en/hi/bo copy is written here
      retry: "Try again",
      reference: "Reference",
    },
  },
  {
    lang: "hi",
    fontFamily: "'Noto Sans Devanagari', 'Nirmala UI', 'Mangal', sans-serif",
    copy: {
      title: "एप्लिकेशन लोड नहीं हो सका",
      body: "यह गड़बड़ी स्वयं व्यवस्था में है, आपके माँगे गए पृष्ठ में नहीं। कृपया अपने कार्यक्रम व्यवस्थापक को इसकी सूचना दें।",
      reload: "फिर से लोड करें",
      retry: "फिर कोशिश करें",
      reference: "संदर्भ",
    },
  },
  {
    lang: "bo",
    fontFamily: "'Noto Serif Tibetan', 'Microsoft Himalaya', 'Jomolhari', serif",
    copy: {
      title: "མཉེན་ཆས་ལོངས་མ་ཐུབ།",
      body: "ནོར་འཁྲུལ་འདི་ལམ་ལུགས་རང་ལ་ཡོད། ཁྱེད་ཀྱིས་འཚོལ་བའི་ཤོག་ངོས་ལ་མེད། ཁྱེད་ཀྱི་ལས་གཞིའི་འགན་འཛིན་ལ་བརྡ་ཐོ་གཏོང་རོགས།",
      reload: "བསྐྱར་དུ་ལོངས།",
      retry: "ཡང་བསྐྱར་ཚོད་ལྟ།",
      reference: "དཔྱད་གཞི།",
    },
  },
];

/**
 * The three languages' versions of one line, side by side, each with its own
 * lang. A plain function, not a component: the text sits directly in the
 * button and link that carry it.
 */
function tri(pick: (c: Copy) => string, sep = " · ") {
  return COPY.map(({ lang, fontFamily, copy }, i) => (
    <span key={lang}>
      {i > 0 ? sep : null}
      <span lang={lang} style={fontFamily ? { fontFamily } : undefined}>
        {pick(copy)}
      </span>
    </span>
  ));
}

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  // lang="en" on the document, and each Hindi and Bhoti line declares its own
  // lang (see tri). The page is prerendered to a static _global-error.html,
  // so it cannot read the locale cookie at render time without a hydration
  // mismatch on the one page that must not fail -- hence all three at once.
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
        {COPY.map(({ lang, fontFamily, copy }) => (
          <div key={lang} lang={lang} style={{ display: "flex", flexDirection: "column", gap: 4, ...(fontFamily ? { fontFamily } : {}) }}>
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>{copy.title}</h1>
            <p style={{ fontSize: 13, color: "#525252", margin: 0, maxWidth: 420 }}>{copy.body}</p>
          </div>
        ))}
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
          {tri((c) => c.reload)}
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
          {tri((c) => c.retry)}
        </button>
        {error.digest ? (
          <p style={{ fontSize: 11, color: "#a3a3a3", margin: 0 }}>
            {tri((c) => c.reference, " / ")} {error.digest}
          </p>
        ) : null}
      </body>
    </html>
  );
}
