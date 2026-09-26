import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_Devanagari, Noto_Serif_Tibetan } from "next/font/google";
import { LOCALE_HTML_LANG, type Locale } from "@/i18n/config";
import { resolveUiLocale, viewerPrefs } from "@/i18n/resolve";
import type { UserPrefs } from "@gml/db/schema";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// NON-LATIN SCRIPTS NEED A FACE THE APP SHIPS. Two of the three UI locales are
// Hindi (Devanagari) and Bhoti (Tibetan), and until now neither face was loaded
// anywhere: --deva named "Noto Sans Devanagari" with no @font-face behind it,
// and there was no Tibetan face at all. Rendering depended entirely on what the
// client machine happened to have installed -- and a school Windows machine in
// Leh with no Tibetan font draws བོད་ཡིག as empty boxes.
//
// next/font self-hosts these (downloaded at build time and served from this
// origin, so nothing is fetched from Google at runtime). preload is OFF: the
// @font-face rules carry unicode-range, so a browser downloads the Tibetan or
// Devanagari file only on a page that actually contains those characters. An
// English-only session pays nothing. globals.css builds --deva and --tib on
// these variables.
const notoDevanagari = Noto_Sans_Devanagari({
  variable: "--font-deva",
  preload: false,
  display: "swap",
});

const notoTibetan = Noto_Serif_Tibetan({
  variable: "--font-tibetan",
  preload: false,
  display: "swap",
});

/**
 * The locale the page will be rendered in, for <html lang>.
 *
 * The same per-request answer i18n/request.ts gives every server-rendered
 * string and the authenticated layout gives its wrapper, font and picker
 * (i18n/resolve.ts): the saved preference when signed in, else the gml-locale
 * cookie. It read the cookie alone, which was a different answer from the
 * layout's whenever the device's cookie and the saved preference differed.
 */
function documentLocale(): Promise<Locale> {
  return resolveUiLocale();
}

/**
 * The Display preferences that have a rule in globals.css, as body classes.
 *
 * Saved on /settings since spec 024 and applied nowhere: the body had a fixed
 * className, so High contrast and Reduced motion answered "Saved" and changed
 * nothing. On <body> rather than a wrapper so the portals mounted there
 * (QuickFind, the anti-download toast) are covered, and server-rendered so a
 * slow connection never paints the page first without them. The row is the
 * one the locale came from, so this costs no query.
 */
function displayClasses(prefs: UserPrefs | null): string {
  if (!prefs) return "";
  return [prefs.highContrast && "a11y-high-contrast", prefs.reducedMotion && "a11y-reduced-motion"]
    .filter(Boolean)
    .join(" ");
}

export const metadata: Metadata = {
  // Still the create-next-app default until now: every browser tab, every
  // bookmark and every screenshot a teacher sent to the helpdesk said
  // "Create Next App".
  title: {
    default: "Goldenmile RTT LMS",
    template: "%s · Goldenmile RTT LMS",
  },
  description:
    "Refresher Teacher Training programme platform for Goldenmile Learning, Ladakh-UT.",
  // Internal tool holding classroom recordings of identifiable children and
  // their guardians' details. It should not be indexed anywhere, ever.
  robots: { index: false, follow: false, nocache: true },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Was hardcoded "en": every Hindi and Bhoti page was announced to a screen
  // reader as English, and the browser applied English line-breaking to
  // Tibetan, which does not break on spaces.
  const locale = await documentLocale();
  const display = displayClasses((await viewerPrefs()).prefs);
  return (
    <html
      lang={LOCALE_HTML_LANG[locale]}
      className={`${geistSans.variable} ${geistMono.variable} ${notoDevanagari.variable} ${notoTibetan.variable} h-full antialiased`}
    >
      <body className={display ? `min-h-full flex flex-col ${display}` : "min-h-full flex flex-col"}>{children}</body>
    </html>
  );
}
