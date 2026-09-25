// The Content-Security-Policy, built per request by proxy.ts (which explains
// each directive and why the policy cannot live in Caddy).
//
// DEVELOPMENT ONLY: 'unsafe-eval' and ws:. React's development build uses
// eval() to rebuild server error stacks in the browser, and `next dev`'s hot
// reload opens a websocket. With the production policy both were blocked, so
// under `next dev` pages rendered but never hydrated. Next's own guide
// (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md)
// allows 'unsafe-eval' in development for exactly this. Only NODE_ENV ===
// "development" gets it: `next start`, the production image and every other
// value get the strict policy. tests/behaviour/csp.test.ts pins both sides.

// Relative, not "@/": tests/behaviour/csp.test.ts imports this module with no
// path-alias hook installed.
import { SCORM_SANDBOX } from "./scorm/sandbox";

export function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://*.supabase.co";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${supabase}`,
    `media-src 'self' blob: ${supabase}`,
    `connect-src 'self' ${supabase} wss://*.supabase.co${isDev ? " ws:" : ""}`,
    "font-src 'self' data:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * The policy for SCORM package files, and ONLY for them
 * (app/api/scorm/content/.../route.ts, which proxy.ts's matcher excludes so
 * that buildCsp's policy is not sent alongside -- both would be enforced).
 *
 * Authoring tools emit inline <script> and handlers, and several eval(), so
 * script-src permits both; a nonce is impossible (the markup is the
 * package's, not ours) and would make browsers ignore 'unsafe-inline'.
 * Everything is 'self': a package is self-contained, and nothing in it may
 * load from or report to another host. Workers from the package or blob: are
 * allowed; a SERVICE worker is refused by the route itself.
 */
export function buildScormContentCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    `sandbox ${SCORM_SANDBOX}`,
    "upgrade-insecure-requests",
  ].join("; ");
}
