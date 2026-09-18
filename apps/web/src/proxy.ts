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
 * Move any cookies the Supabase client set onto a different response.
 *
 * A redirect or rewrite creates a NEW response object, and the refreshed token
 * pair lives on the one `NextResponse.next()` produced. Returning the redirect
 * without this drops the rotation on exactly the requests where it matters most
 * -- the ones already bouncing a user around the auth boundary.
 */
function carryCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  return to;
}

export default async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // Misconfiguration must not open the door. With no credentials we cannot
  // establish who anyone is, so no session exists -- and because auth() in the
  // layouts reads the same env, every protected page fails closed there too.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Verifies the JWT signature locally against the project's JWKS (this project
  // signs ES256, so there is no network hop) and rotates the token when it is
  // near expiry. Calling it is what makes job 1 happen; the claims are a bonus.
  let role: unknown;
  let signedIn = false;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (!error && data?.claims) {
      signedIn = true;
      role = (data.claims as unknown as Record<string, unknown>).user_role;
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
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/media|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|woff|woff2|ttf|otf|mp4|webm|m3u8|ts)$).*)",
  ],
};
