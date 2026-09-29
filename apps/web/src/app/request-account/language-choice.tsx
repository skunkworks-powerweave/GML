"use client";

// The interface language, before sign-in: the same choice the login screens
// offer (it writes the pre-auth gml-locale cookie and re-renders), laid out as
// a row that wraps, because this page is often opened on a phone from a
// shared link. The labels and the cookie's name come from the server page.

import { useTransition } from "react";
import { useRouter } from "next/navigation";

const ONE_YEAR = 60 * 60 * 24 * 365;

export type LanguageOption = { code: "en" | "hi" | "bo"; label: string; current: boolean };

/** Remember the choice for a year, as the login screens' picker does. */
function rememberLanguage(cookieName: string, code: string): void {
  document.cookie = `${cookieName}=${code}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

export function LanguageChoice({ cookieName, options, label }: { cookieName: string; options: LanguageOption[]; label: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const pick = (code: string) => {
    rememberLanguage(cookieName, code);
    startTransition(() => router.refresh());
  };
  return (
    <div role="group" aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" }}>
      {options.map((o) => (
        <button
          key={o.code}
          type="button"
          lang={o.code}
          aria-pressed={o.current}
          onClick={() => pick(o.code)}
          className={o.code === "hi" ? "btn btn-sm btn-ghost deva" : o.code === "bo" ? "btn btn-sm btn-ghost tib" : "btn btn-sm btn-ghost"}
          style={{ minHeight: 36, fontWeight: o.current ? 600 : 400 }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
