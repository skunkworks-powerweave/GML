// The attributes the Supabase session cookie is written with.
//
// Used by BOTH places that write it: lib/supabase/server.ts (sign-in, sign-out
// and recovery, in Server Actions and Route Handlers) and proxy.ts (the token
// refresh on every request). If they disagreed, the first refresh would
// silently rewrite whatever the sign-in set.
//
// WHAT WAS WRONG. Neither passed cookie options, so @supabase/ssr's defaults
// applied: no Secure attribute and Max-Age 400 days. The cookie carries the
// refresh token, which does not expire on its own. A plain-HTTP request to the
// domain -- typed without https, before HSTS is cached -- sent the session in
// cleartext ahead of Caddy's redirect, and a teacher who closed the browser on
// a shared school computer without signing out left the next person signed in
// as her for up to 400 days.
//
//   Secure     whenever the site is served over https: APP_URL when it is set
//              (compose always sets it), else the request's forwarded protocol.
//              Plain-http local development keeps working.
//   Max-Age    at most SESSION_COOKIE_MAX_AGE_SECONDS. Every refresh rewrites
//              the cookie, so for someone using the site this is "twelve hours
//              after they stopped", i.e. an inactivity bound in the browser.
//              The absolute bound is Supabase's session time-box
//              (README-deploy §2.2), which also covers a copied cookie.
//   httpOnly   stays false, which is @supabase/ssr's design: the browser
//              client reads the access token for direct-to-Storage uploads.
//
// @supabase/ssr 0.12 applies its 400-day Max-Age AFTER any cookieOptions it is
// given, so the bound cannot be passed in; boundSessionCookie() applies it to
// each write instead.
//
// No "server-only": proxy.ts imports this, and it is pure.

import type { CookieOptions } from "@supabase/ssr";

/** Twelve hours: a school day, then sign in again. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Is the site served over https? */
export function isSecureOrigin(appUrl: string | undefined, forwardedProto: string | null | undefined): boolean {
  const configured = appUrl?.trim();
  if (configured) return configured.toLowerCase().startsWith("https://");
  return (forwardedProto ?? "").split(",")[0]!.trim().toLowerCase() === "https";
}

/** cookieOptions for createServerClient. The Max-Age there is ignored; see header. */
export function sessionCookieOptions(secure: boolean): CookieOptions {
  return { path: "/", sameSite: "lax", secure, httpOnly: false };
}

/** The options one cookie write should actually use. Deletions (Max-Age 0) pass through. */
export function boundSessionCookie(options: CookieOptions | undefined, secure: boolean): CookieOptions {
  const out: CookieOptions = { ...options, secure };
  if (typeof out.maxAge === "number" && out.maxAge > 0) {
    out.maxAge = Math.min(out.maxAge, SESSION_COOKIE_MAX_AGE_SECONDS);
  }
  return out;
}
