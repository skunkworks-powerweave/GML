"use client";

// Pre-auth language picker — sets a 365-day `gml-locale` cookie and reloads
// the page. The login route's layout reads this cookie server-side (with
// English as default) to render its labels through next-intl. After sign-in,
// the language source of truth shifts to `user_prefs.uiLanguage` — this
// cookie is informational and effectively ignored once the authenticated
// layout takes over.
//
// 1:1 port of `LMS GML Frontend/login.jsx` line 165's 3-button picker.

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_LABELS } from "@/i18n/config";

const ONE_YEAR = 60 * 60 * 24 * 365;

export function LoginLanguagePicker({
  labels,
}: {
  labels: { english: string; hindi: string; bhoti: string };
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  function pick(locale: "en" | "hi" | "bo") {
    document.cookie = `gml-locale=${locale}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <div style={{ position: "absolute", top: 18, right: 18, display: "flex", gap: 4 }}>
      <button
        type="button"
        onClick={() => pick("en")}
        className="btn btn-sm btn-ghost"
        style={{ minWidth: 32, justifyContent: "center" }}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => pick("hi")}
        className="btn btn-sm btn-ghost deva"
        lang="hi"
        aria-label={labels.hindi}
        style={{ minWidth: 32, justifyContent: "center" }}
      >
        {labels.hindi}
      </button>
      {/* Bhoti/Ladakhi chip. The visible glyph comes from LOCALE_LABELS, not a
          hand-written literal: this button shipped showing two ARABIC letters
          (U+0644 U+062F) because the glyph had been copied by hand into four
          files and diverged from the Tibetan script bo actually uses. Only the
          invisible aria-label was right, so no a11y check could see it. The
          wrong codepoints are named here, never written, so a source-text test
          for them cannot pass on the strength of this comment. `tib` loads
          the bundled Tibetan face (globals.css --tib) so the chip does not
          depend on the client machine having one installed. */}
      <button
        type="button"
        onClick={() => pick("bo")}
        className="btn btn-sm btn-ghost tib"
        lang="bo"
        aria-label={labels.bhoti}
        style={{ minWidth: 32, justifyContent: "center" }}
      >
        {LOCALE_LABELS.bo.script}
      </button>
    </div>
  );
}
