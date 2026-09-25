// Session refresh + coarse RBAC dispatcher.
//
// TWO JOBS, AND THE FIRST IS THE ONE THAT CANNOT BE DONE ANYWHERE ELSE.
//
// 1. REFRESH THE SUPABASE SESSION. Access tokens are short-lived and the
//    refresh token rotates. `getClaims()` below performs that rotation when the
//    token is near expiry, and the new cookie pair must be written to the
//    RESPONSE. Server Components cannot set cookies -- `cookies().set()` throws
//    there by design -- so a refresh that happens inside a page or layout is
//    computed and then silently discarded. This file is the only request path
//    that can persist it, which is why the matcher below is a catch-all rather
//    than the six prefixes it used to be. Without that, users on /videos,
//    /forms, /quizzes, /repo, /settings, /uploads and /inbox would be bounced
//    to /login roughly once per access-token lifetime.
//
// 2. COARSE ROLE ROUTING, so an unauthorised user gets /forbidden instead of a
//    half-rendered page.
//
// SM-1 REMINDER (Spec 163). Changes here must not bypass the audit log. The
// auditing is wired through the API handlers -- see the recordAudit calls in
// apps/web/src/app/api/**. Any new branch added below that short-circuits a
// request BEFORE it reaches its handler must explicitly consider whether SM-1
// coverage is still preserved on the bypassed path.
//
// WHAT THIS FILE IS NOT. It is not the authorization boundary. Next's own
// reference is explicit that Server Functions are POSTs to the route that hosts
// them, so a matcher edit or a refactor can silently remove proxy coverage from
// a mutation. Authorization is therefore enforced where the data is touched:
// lib/authz.ts for object ownership, lib/api-guards.ts at the route boundary,
// lib/guards.tsx for role, and assertSectionGate() in the gated layouts. What
// runs here is defence in depth and a better redirect.
//
// SECTION GATES ARE DELIBERATELY NOT CHECKED HERE. This file used to compare a
// `gml-gate-<slug>` cookie against the string "1". That was the whole check:
// unsigned, not bound to a user, never validated against section_gate_grants --
// so `curl -H 'Cookie: gml-gate-mentorship=1'` walked in, and rotating a
// section password revoked nobody, because the decision never read the rows
// that rotation deletes. Enforcement now lives in the gated segments' layouts
// (assertSectionGate -> getActiveGrant). It is NOT duplicated here as a "fast
// path": a cookie hint produces FALSE NEGATIVES, denying a user who holds a
// valid grant but no cookie (cleared cookies, a second browser, an expired
// marker on a live grant). One authority, one answer.
//
// NEXT 16: the `middleware` convention is deprecated and renamed to `proxy`.
// The rename is not cosmetic -- proxy runs on the NODE.JS runtime and that is
// not configurable (setting `runtime` throws). Under the old Edge default, this
// file's `import { auth } from "@/auth"` dragged DrizzleAdapter -> pg -> node
// `stream` into an Edge bundle and threw at REQUEST time, in the production
// image, on every matched route:
//
//     Error: The edge runtime does not support Node.js 'stream' module.
//
// `next build` reported success, so the entire authorization layer was dead in
// production and nothing said so. See docs/verification.md (B11).

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { hasAnyRole, isRoleName, type RoleName } from "@gml/shared/auth/roles";
import { buildCsp } from "@/lib/csp";
import { boundSessionCookie, isSecureOrigin, sessionCookieOptions } from "@/lib/supabase/cookies";
import { mustChangePassword } from "@/lib/password-policy";

type PolicyRule = {
  prefix: string;
  roles?: RoleName[];
  loggedIn?: boolean;
};

// Every authenticated segment is listed, not just the six that used to be.
// These duplicate the (authenticated) layout's own check on purpose: the layout
// remains the authority, this is the cheap early exit.
const POLICIES: PolicyRule[] = [
  { prefix: "/admin", roles: ["programme_admin", "super_admin"] },
  { prefix: "/dashboard", loggedIn: true },
  { prefix: "/observation", loggedIn: true },
  { prefix: "/rtt", loggedIn: true },
  { prefix: "/mentorship", loggedIn: true },
  { prefix: "/gate", loggedIn: true },
  { prefix: "/videos", loggedIn: true },
  { prefix: "/forms", loggedIn: true },
  { prefix: "/quizzes", loggedIn: true },
  { prefix: "/repo", loggedIn: true },
  { prefix: "/settings", loggedIn: true },
  { prefix: "/uploads", loggedIn: true },
  { prefix: "/inbox", loggedIn: true },
];

function matchPolicy(pathname: string): PolicyRule | undefined {
  return POLICIES.find((p) => pathname === p.prefix || pathname.startsWith(p.prefix + "/"));
}

/**
 * Build the per-request Content-Security-Policy.
 *
 * ── WHY THIS MOVED OUT OF CADDY ──────────────────────────────────────────────
 *
 * The Caddyfile served `script-src 'self'` with no nonce. A production Next
 * build emits its entire RSC flight payload through INLINE
 * `<script>self.__next_f.push(...)</script>` tags -- six of them on /login,
 * measured against the built image -- and `'self'` does not permit inline
 * script. Every browser would have blocked all six, React would never have
 * hydrated, and the application would have been a dead static shell behind
 * TLS. The Caddyfile comment asserted that "a production Next build needs
 * neither [unsafe-inline nor unsafe-eval]" and told the reader to verify it in
 * a browser; that verification never happened, because Caddy cannot bind :80
 * on the development machine. It was wrong.
 *
 * A nonce is the fix, and it can only be minted where a request is -- Caddy
 * emits one static header for every response. Next reads the nonce from the
 * `content-security-policy` header on the INCOMING request (see
 * get-script-nonce-from-header.js) and stamps it onto every script tag it
 * renders, so the policy and the markup are generated together and cannot
 * drift.
 *
 * NOTE: Caddy must NOT also send a CSP. Two CSP headers are both enforced, and
 * the intersection of a nonce policy and a nonce-less one blocks everything the
 * nonce was added to allow.
 *
 * ── DIRECTIVE NOTES ──────────────────────────────────────────────────────────
 *
 *   script-src   'strict-dynamic' lets the nonced bootstrap load the chunk
 *                graph without listing every chunk. `'self'` is kept purely as
 *                a CSP2 fallback -- CSP3 browsers ignore it once
 *                'strict-dynamic' is present.
 *
 *   style-src    Carries 'unsafe-inline' and DELIBERATELY NO NONCE. A nonce in
 *                style-src makes browsers ignore 'unsafe-inline', and this
 *                codebase styles pervasively through inline `style=`
 *                attributes -- which a nonce cannot cover, since an attribute
 *                has nowhere to carry one. Adding a style nonce would strip the
 *                application's styling instead of protecting it.
 *
 *   connect-src  Supabase over both https and wss: the browser client talks to
 *                Storage directly for resumable uploads.
 */
// Built in lib/csp.ts (unit-tested there, per environment).

/**
 * The baseline security headers, set by the APPLICATION.
 *
 * Caddy sets these too, and that is fine -- its `header` directive replaces
 * rather than appends, so there is no duplication. The reason they are here as
 * well is that the application should not depend on its reverse proxy for its
 * own baseline: anything that reaches the app directly (a misconfigured
 * security group, a future load balancer, a developer running the container
 * without Caddy, the health checker) got no protection at all. Defence in
 * depth costs three header writes per request.
 *
 * The CSP genuinely cannot live in Caddy -- see buildCsp -- so these travel
 * with it.
 */
function applySecurityHeaders(res: NextResponse, csp: string): NextResponse {
  res.headers.set("content-security-policy", csp);
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  res.headers.set(
    "permissions-policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  );
  return res;
}

/** 128 bits of randomness, base64. Must be unpredictable and per-request. */
function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Move any cookies the Supabase client set onto a different response.
 *
 * A redirect or rewrite creates a NEW response object, and the refreshed token
 * pair lives on the one `NextResponse.next()` produced. Returning the redirect
 * without this drops the rotation on exactly the requests where it matters most
 * -- the ones already bouncing a user around the auth boundary.
 */
function carryCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  // The CSP travels with them. The /forbidden rewrite RENDERS a page, so
  // without this it would be served with no policy at all -- and a 403 is
  // exactly the kind of response an attacker is looking at.
  const csp = from.headers.get("content-security-policy");
  if (csp) applySecurityHeaders(to, csp);
  return to;
}

export default async function proxy(request: NextRequest) {
  const nonce = makeNonce();
  const csp = buildCsp(nonce);

  /**
   * Every response this function returns is built here.
   *
   * The request headers are re-snapshotted on each call rather than captured
   * once: the Supabase cookie writer mutates `request.cookies`, which rewrites
   * the request's own Cookie header, and a stale snapshot would forward the
   * pre-rotation cookies to the renderer.
   */
  const nextWithCsp = (): NextResponse => {
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", csp);
    headers.set("x-nonce", nonce);
    // The requested path, for server components that need it. A layout cannot
    // otherwise discover which URL it is rendering, so the gated layouts had to
    // hardcode a section root as their post-unlock destination and threw away
    // whatever deep link the user actually followed.
    headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
    const res = NextResponse.next({ request: { headers } });
    applySecurityHeaders(res, csp);
    return res;
  };

  let response = nextWithCsp();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // Misconfiguration must not open the door. With no credentials we cannot
  // establish who anyone is, so no session exists -- and because auth() in the
  // layouts reads the same env, every protected page fails closed there too.
  if (!url || !key) return response;

  // The refreshed session is written with the same attributes sign-in used
  // (Secure behind https, bounded Max-Age); see lib/supabase/cookies.ts.
  const secure = isSecureOrigin(process.env.APP_URL, request.headers.get("x-forwarded-proto"));
  const supabase = createServerClient(url, key, {
    cookieOptions: sessionCookieOptions(secure),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = nextWithCsp();
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, boundSessionCookie(options, secure));
        }
      },
    },
  });

  // Verifies the JWT signature locally against the project's JWKS (this project
  // signs ES256, so there is no network hop) and rotates the token when it is
  // near expiry. Calling it is what makes job 1 happen; the claims are a bonus.
  let role: unknown;
  let signedIn = false;
  let mustChange = false;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (!error && data?.claims) {
      signedIn = true;
      const claims = data.claims as unknown as Record<string, unknown>;
      role = claims.user_role;
      mustChange = mustChangePassword(claims.app_metadata);
    }
  } catch {
    // Treated as signed-out: fail closed.
  }

  const { nextUrl } = request;
  const policy = matchPolicy(nextUrl.pathname);
  if (!policy) return response;

  // Spec 150 -- the 401-vs-403 split. Preserved verbatim across the move from
  // Auth.js to Supabase: only the way the session is established changed.
  //
  // 401-equivalent: unauthenticated. Redirect (302) to /login with the original
  // path in `from=` so login can bounce back. This branch MUST run before the
  // role gate -- otherwise an anonymous visit to /admin/* yields a 403, hiding
  // the fact that the user simply needs to sign in.
  //
  // `from` is consumed by the login action, which validates it is a same-site
  // absolute path before redirecting. `next` is kept for older callers.
  if (!signedIn || !isRoleName(role)) {
    const target = nextUrl.clone();
    target.pathname = "/login";
    target.search = "";
    target.searchParams.set("from", nextUrl.pathname + (nextUrl.search ?? ""));
    target.searchParams.set("next", nextUrl.pathname);
    return carryCookies(response, NextResponse.redirect(target));
  }

  // A password somebody else chose (an administrator created the account or
  // set it) must be replaced before anything else. The flag is in the token's
  // app_metadata -- see lib/password-policy.ts -- so this costs no query.
  // /settings is where it is changed, so it stays reachable. This is a
  // hand-holding step, not an authorization boundary: the person does hold a
  // valid session, and the API routes are not redirected.
  if (mustChange && policy.prefix !== "/settings") {
    const target = nextUrl.clone();
    target.pathname = "/settings";
    target.search = "?password=required";
    return carryCookies(response, NextResponse.redirect(target));
  }

  // 403: authenticated but under-privileged. Rewrite (not redirect) so the URL
  // bar still shows the attempted path, with an explicit 403 status so curl,
  // fetch and monitoring probes see the right code without scraping the body --
  // a default rewrite would return 200.
  if (policy.roles && !hasAnyRole(role, policy.roles)) {
    const target = nextUrl.clone();
    target.pathname = "/forbidden";
    target.search = "";
    return carryCookies(response, NextResponse.rewrite(target, { status: 403 }));
  }

  return response;
}

export const config = {
  matcher: [
    // Catch-all, minus four classes of path:
    //
    //   _next/static, _next/image, favicon, asset extensions
    //       Static bytes. No session to refresh and no policy to apply;
    //       matching them would put a JWKS verification on every image.
    //   api/webhooks/*
    //       Meta's WhatsApp callback. Authenticated by HMAC over the raw body,
    //       carries no cookies, and a redirect to /login would be answered with
    //       retries rather than a sign-in.
    //   api/media/*
    //       Video segment delivery, authenticated by signed URL. This is the
    //       hottest path in the product (~200 segment requests per view) and
    //       must not pay for a session check it does not use.
    //   api/health
    //       Probed by Docker and the load balancer, which have no session and
    //       must not be redirected.
    //   api/scorm/content/*
    //       SCORM package files. They carry their OWN policy
    //       (buildScormContentCsp), which permits the inline script SCORM
    //       content is built on. Passing through here would add the nonce
    //       policy as well, and a browser enforces both: the intersection
    //       blocks the content. The route authenticates itself (auth()), and
    //       sets the baseline headers applySecurityHeaders would have.
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/media|api/health|api/scorm/content/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|woff|woff2|ttf|otf|mp4|webm|m3u8|ts)$).*)",
  ],
};
