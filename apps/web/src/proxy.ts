// RBAC + section-gate dispatcher middleware.
//
// Substrate-moat reminder: changes here must not bypass SM-1 (the audit
// log). The auditing middleware shipped in spec 010 and is wired through
// the API handlers — see `recordAudit` calls in apps/web/src/app/api/**.
// Any new branch added below that bypasses an API call must explicitly
// consider whether SM-1 coverage is still preserved on the bypassed path.
//
// Spec 163 — Workflow Run 15 audit-closure NIT: the previous comment
// at this position promised the auditing middleware was still
// inbound — but that promise was stale (the relevant phase-1 spec
// shipped long ago). Replaced with the up-to-date note above so a
// future reader isn't sent looking for a non-existent gap.
//
// Spec 150 (Workflow Run 14 audit-closure, MEDIUM): the auth-failure path is
// split into two distinct response shapes so observers (humans and tools)
// can distinguish "you need to log in" from "you logged in but lack the
// role". The two paths are deliberately not collapsed into a single 403:
//
//   1. No session → 302 redirect to `/login?from=<encoded-original-path>`.
//      Semantically 401-equivalent (the user is unauthenticated; the
//      browser redirect prompts them to authenticate). The `from` query
//      param lets the login page bounce them back to the originally-
//      requested page on success.
//   2. Session present + role check fails → rewrite to `/forbidden` with
//      an EXPLICIT `status: 403`. The user is authenticated but not
//      authorised; logging in as a different user would not change the
//      outcome (their account simply doesn't have the role). Status 403
//      is set on the rewrite response itself so curl / fetch callers see
//      the correct HTTP code without parsing the body.
//
// The role gate (POLICIES check at line ~75) MUST run only after the
// session-present check passes — otherwise an unauthenticated visit to
// `/admin/*` would short-circuit into a 403 rewrite (the audit finding),
// hiding the fact that the user just needs to log in.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { hasAnyRole, type RoleName } from "@gml/shared/auth/roles";

type PolicyRule = {
  prefix: string;
  roles?: RoleName[];
  loggedIn?: boolean;
};

const POLICIES: PolicyRule[] = [
  { prefix: "/admin", roles: ["programme_admin", "super_admin"] },
  { prefix: "/dashboard", loggedIn: true },
  { prefix: "/observation", loggedIn: true },
  { prefix: "/rtt", loggedIn: true },
  { prefix: "/mentorship", loggedIn: true },
  { prefix: "/gate", loggedIn: true },
];

// Gated prefixes — checked via `gml-gate-<slug>=1` cookie (set by gate page) so
// middleware (Edge runtime) avoids a DB hit per request.
const GATED_PREFIXES: { prefix: string; slug: string }[] = [
  { prefix: "/mentorship", slug: "mentorship" },
  { prefix: "/observation", slug: "observation" },
  { prefix: "/rtt/tkt", slug: "tkt" },
  { prefix: "/rtt/ttt", slug: "ttt" },
];

function matchPolicy(pathname: string): PolicyRule | undefined {
  return POLICIES.find((p) => pathname === p.prefix || pathname.startsWith(p.prefix + "/"));
}

function matchGate(pathname: string): { slug: string } | undefined {
  return GATED_PREFIXES.find(
    (g) => pathname === g.prefix || pathname.startsWith(g.prefix + "/"),
  );
}

// Next 16 renamed the `middleware` file convention to `proxy`. The rename is not
// cosmetic here: `proxy` runs on the NODE.JS runtime (and that is not
// configurable -- setting `runtime` throws), whereas `middleware` defaulted to
// the Edge runtime.
//
// That matters because this file imports `auth` from "@/auth", which pulls in
// DrizzleAdapter -> pg -> the Node `stream` module. Under Edge that threw at
// REQUEST time, in the production image, on every matched route:
//
//     Error: The edge runtime does not support Node.js 'stream' module.
//
// `next build` reported success, so the entire authorization layer -- role
// policies, section gates, the login redirect -- was dead in production and
// nothing said so. See docs/verification.md (B11).
export default auth((req) => {
  const { nextUrl, cookies: reqCookies } = req as unknown as NextRequest;
  const session = (req as unknown as { auth?: { user?: { role?: string } } }).auth;
  const policy = matchPolicy(nextUrl.pathname);
  if (!policy) return NextResponse.next();

  // Spec 150 — 401-equivalent path: no session means the user is
  // unauthenticated. Redirect (302) to /login with the original path
  // captured in `from=` so the login page can bounce back on success.
  // The legacy `next=` param is preserved alongside `from=` so any
  // older callers reading `next` still work — the new `from` name
  // matches the spec-150 contract and the rest of the LMS audit-export
  // convention. CRITICALLY this branch runs BEFORE the role gate so an
  // unauthenticated visit to /admin/* yields a redirect, not a 403.
  if (!session?.user) {
    const url = nextUrl.clone();
    url.pathname = "/login";
    const encoded = nextUrl.pathname + (nextUrl.search ?? "");
    url.searchParams.set("from", encoded);
    url.searchParams.set("next", nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  // Spec 150 — 403 path: session is present but role is insufficient.
  // The user IS authenticated; logging in as a different user wouldn't
  // help — they simply lack the role. Rewrite (NOT redirect) to
  // /forbidden so the URL bar still shows the protected path the user
  // attempted, and force status 403 on the rewrite response so
  // non-browser callers (curl, fetch, monitoring probes) see the
  // correct HTTP code without scraping the body. The default
  // NextResponse.rewrite returns 200 for the destination page; the
  // `{ status: 403 }` override is what makes this branch genuinely
  // 403 rather than "rendered the forbidden page with status 200".
  if (policy.roles && !hasAnyRole(session.user.role, policy.roles)) {
    const url = nextUrl.clone();
    url.pathname = "/forbidden";
    return NextResponse.rewrite(url, { status: 403 });
  }

  const gateHit = matchGate(nextUrl.pathname);
  if (gateHit) {
    // Cookie marker (`gml-gate-<slug>=1`) is set by /gate/<slug>/actions on
    // successful password entry. Lasts 8h (SM-2). Middleware reads cookie here
    // so the Edge runtime doesn't have to hit Postgres on every request.
    const cookieName = `gml-gate-${gateHit.slug}`;
    const cookieValue = reqCookies?.get?.(cookieName)?.value;
    if (cookieValue !== "1") {
      const url = nextUrl.clone();
      url.pathname = `/gate/${gateHit.slug}`;
      url.searchParams.set("next", nextUrl.pathname);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
    "/observation/:path*",
    "/rtt/:path*",
    "/mentorship/:path*",
    "/gate/:path*",
  ],
};
