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

let cached: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase is not configured for this deployment.");
  }
  cached = createBrowserClient(url, key);
  return cached;
}

/**
 * The current access token, or null.
 *
 * Used as the TUS Authorization header. Returns null rather than throwing when
 * there is no session, so the caller can render "please sign in again" instead
 * of an unhandled error inside a file picker.
 */
export async function accessToken(): Promise<string | null> {
  try {
    const { data } = await supabaseBrowser().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
