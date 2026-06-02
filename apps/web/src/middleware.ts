// RBAC + section-gate dispatcher middleware.
//
// Substrate-moat reminder: changes here must not bypass SM-1 (audit log) once
// the auditing middleware lands in spec 010.
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
