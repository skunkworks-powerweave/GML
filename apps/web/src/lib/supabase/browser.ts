"use client";

// Browser-side Supabase client.
//
// ONLY for direct-to-Storage uploads. Nothing else in this application talks to
// Supabase from the browser: every read and every authorization decision
// happens server-side, and this exists solely so the upload can hand Storage a
// token that belongs to the user rather than routing gigabytes of video through
// the application server.
//
// The session comes from the same cookies `@supabase/ssr` writes server-side.
// Those cookies are NOT httpOnly -- that is the library's own default, because
// the browser client is expected to read them. It is a real trade-off: an XSS
// on this origin yields the access token. That is why the Content-Security
// Policy is load-bearing here rather than hygiene, and why the token is
// short-lived and re-minted through the access-token hook on every refresh.
//
// The publishable key is safe in the bundle by design -- it is the anon key,
// and on its own it grants nothing: _post/002 revoked every table privilege
// from `anon` and enabled RLS with no policies, and _post/005 grants Storage
// writes only to `authenticated`, only under the caller's own uuid prefix.

import {
  createBrowserClient,
  parseCookieHeader,
  serializeCookieHeader,
  type CookieMethodsBrowser,
} from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { boundSessionCookie } from "@/lib/supabase/cookies";

/**
 * Config is PASSED IN, not read from process.env.
 *
 * NEXT_PUBLIC_* is inlined into the client bundle at BUILD time. This module is
 * a "use client" module, so reading process.env here made the two values a
 * build-time requirement — and the app image is built with only DATABASE_URL
 * set. Verified in a browser against the production image: `process` is
 * undefined, the values are nowhere in the served page, and every upload
 * therefore failed with "Uploads are not configured on this deployment" while
 * the deployment was configured perfectly.
 *
 * Build args would have fixed it and made the image environment-specific —
 * build once for staging and it carries staging's project URL forever. Instead
 * the values ride back on beginUploadAction's response: that action runs
 * server-side at request time, where the real environment is visible, so the
 * image stays portable and the config arrives exactly when the upload needs it.
 *
 * The publishable key is safe to hand the browser either way — it is the anon
 * key, and _post/002 stripped `anon` of every table privilege.
 */
export type SupabaseBrowserConfig = { url: string; anonKey: string };

/**
 * document.cookie, with every write bounded as the server's writes are.
 *
 * Given no cookie methods, createBrowserClient writes document.cookie itself
 * with @supabase/ssr's defaults: Max-Age 400 days, no Secure. And in a browser
 * it refreshes the session on its own, on a timer, for as long as the page is
 * open -- which on a long upload is many 15-minute tokens -- so each refresh
 * rewrote the cookie the server had written Secure and bounded
 * (lib/supabase/cookies.ts) as neither. The library applies
 * its 400-day Max-Age after any cookieOptions, so the bound goes on each
 * write here. Secure follows the page: an http page (local development) could
 * not set a Secure cookie at all.
 */
const sessionCookies: CookieMethodsBrowser = {
  getAll: () => parseCookieHeader(document.cookie),
  setAll: (toSet) => {
    const secure = window.location.protocol === "https:";
    for (const { name, value, options } of toSet) {
      document.cookie = serializeCookieHeader(name, value, boundSessionCookie(options, secure));
    }
  },
};

let cached: { key: string; client: SupabaseClient } | null = null;

export function supabaseBrowser(config: SupabaseBrowserConfig): SupabaseClient {
  const cacheKey = `${config.url}|${config.anonKey}`;
  if (cached && cached.key === cacheKey) return cached.client;
  const client = createBrowserClient(config.url, config.anonKey, { cookies: sessionCookies });
  cached = { key: cacheKey, client };
  return client;
}

/**
 * The current access token, or null.
 *
 * Used as the TUS Authorization header. Returns null rather than throwing when
 * there is no session, so the caller can say "please sign in again" instead of
 * surfacing an unhandled error from inside a file picker.
 */
export async function accessToken(config: SupabaseBrowserConfig): Promise<string | null> {
  try {
    const { data } = await supabaseBrowser(config).auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
