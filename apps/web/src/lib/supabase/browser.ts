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

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

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

let cached: { key: string; client: SupabaseClient } | null = null;

export function supabaseBrowser(config: SupabaseBrowserConfig): SupabaseClient {
  const cacheKey = `${config.url}|${config.anonKey}`;
  if (cached && cached.key === cacheKey) return cached.client;
  const client = createBrowserClient(config.url, config.anonKey);
  cached = { key: cacheKey, client };
  return client;
}

/**
 * The current access token, or null.
 *
 * Used as the TUS Authorization header, asked for again before EVERY request of
 * an upload: getSession() refreshes the session when its token is close to
 * expiry, so each call returns a token with time left on it. `refresh` forces
 * a new token for the case where Storage has refused one the browser still
 * believes valid (clock skew, or a refresh that has not run yet).
 *
 * Returns null rather than throwing when there is no session, so the caller
 * can say "please sign in again" instead of surfacing an unhandled error from
 * inside a file picker.
 */
export async function accessToken(
  config: SupabaseBrowserConfig,
  opts: { refresh?: boolean } = {},
): Promise<string | null> {
  try {
    const client = supabaseBrowser(config);
    if (opts.refresh) {
      const { data } = await client.auth.refreshSession();
      if (data.session) return data.session.access_token;
    }
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
