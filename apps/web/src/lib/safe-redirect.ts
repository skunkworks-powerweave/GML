import "server-only";

// Where the application may send a user next, and how to build that URL.
//
// Two defects lived here as copies:
//
//   1. Three `safeNext` guards (auth callback, login, section gate) rejected
//      `//evil` and `/\evil` but not a control character. `?from=/%09/evil.example`
//      decodes to "/\t/evil.example"; browsers strip tabs and newlines from URLs,
//      so the user landed on evil.example right after a genuine sign-in.
//   2. Route handlers built redirects from the request's own URL. Behind Caddy
//      that is Next's bind address, so callbacks sent users to
//      https://0.0.0.0:3000/... in production.

import { appOrigin } from "@/lib/auth-email";

const BASE = "http://internal.invalid";

/**
 * A same-origin path, or the fallback.
 *
 * Decides by what a URL parser makes of it, not by prefix-matching the forms
 * someone thought of: anything that is not a plain path on OUR origin -- or
 * that carries characters a browser silently removes -- is refused.
 */
export function safeInternalPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || raw.length > 2048 || !raw.startsWith("/")) return fallback;
  // Browsers strip ASCII tab/newline/CR and treat "\" as "/"; any control
  // character or backslash makes the string mean something else to them.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  if (raw.startsWith("//")) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (parsed.origin !== BASE || parsed.pathname.startsWith("//")) return fallback;
  return raw;
}

/** An absolute URL on the site's PUBLIC origin, for NextResponse.redirect. */
export async function publicUrl(path: string): Promise<URL> {
  return new URL(safeInternalPath(path), await appOrigin());
}
