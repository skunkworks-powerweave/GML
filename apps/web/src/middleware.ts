// RBAC + section-gate dispatcher middleware.
//
// Substrate-moat reminder: changes here must not bypass SM-1 (audit log) once
// the auditing middleware lands in spec 010.

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

  if (!session?.user) {
    const url = nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  if (policy.roles && !hasAnyRole(session.user.role, policy.roles)) {
    const url = nextUrl.clone();
    url.pathname = "/forbidden";
    return NextResponse.rewrite(url);
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
