// Login route-segment layout (spec 125). Resolves the UI locale and wraps the
// page in NextIntlClientProvider so the "use client" page can call
// `useTranslations()` against it.
//
// The locale comes from the same per-request resolver as <html lang> and
// every other reader (i18n/resolve.ts). Signed out -- this segment's usual
// case -- that is the optional pre-auth `gml-locale` cookie the language
// picker sets, with English for first-time visitors who haven't picked yet.
// Signed in (/login/reset, reached from a recovery link with a session), it
// is the user's saved language. This layout used to read the cookie on its
// own, so on a signed-in login route <html lang> named the saved language
// while this wrapper, its font and its strings used the cookie's.

import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { loadMessages, LOCALE_FONT_FAMILY, LOCALE_HTML_LANG } from "@/i18n/config";
import { resolveUiLocale } from "@/i18n/resolve";

export default async function LoginLayout({ children }: { children: ReactNode }) {
  const locale = await resolveUiLocale();
  const messages = loadMessages(locale);
  const fontFamily = LOCALE_FONT_FAMILY[locale];

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {/* lang, not only data-locale: a data attribute reaches neither the
          browser nor assistive tech. The root layout already sets <html lang>
          from the same resolver; this keeps the segment self-describing. */}
      <div
        data-locale={locale}
        lang={LOCALE_HTML_LANG[locale]}
        style={fontFamily ? { fontFamily } : undefined}
      >
        {children}
      </div>
    </NextIntlClientProvider>
  );
}
