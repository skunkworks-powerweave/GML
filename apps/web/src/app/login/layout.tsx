// Login route-segment layout (spec 125). Reads the optional pre-auth
// `gml-locale` cookie and wraps the page in NextIntlClientProvider so the
// "use client" page can call `useTranslations()` against the picked locale.
// English is the default for first-time visitors who haven't picked yet.

import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import {
  loadMessages,
  normalizeLocale,
  LOCALE_COOKIE,
  LOCALE_FONT_FAMILY,
  LOCALE_HTML_LANG,
} from "@/i18n/config";

export default async function LoginLayout({ children }: { children: ReactNode }) {
  const cookieJar = await cookies();
  const cookieLocale = cookieJar.get(LOCALE_COOKIE)?.value;
  const locale = normalizeLocale(cookieLocale);
  const messages = loadMessages(locale);
  const fontFamily = LOCALE_FONT_FAMILY[locale];

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {/* lang, not only data-locale: a data attribute reaches neither the
          browser nor assistive tech. The root layout already sets <html lang>
          from the same cookie; this keeps the segment self-describing. */}
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
