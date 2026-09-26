import "server-only";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { hasAnyRole, type RoleName } from "@gml/shared/auth/roles";
import { rateLimit } from "@/lib/rate-limit";
import type { Session } from "@/auth";

/**
 * Authorization guard for ROUTE HANDLERS.
 *
 * `requireRole()` in lib/guards.tsx calls `redirect()`, which is right for a
 * page but wrong for an API: a fetch/curl caller gets a 307 to /forbidden
 * instead of a status it can branch on, and a client following redirects sees
 * an HTML page where it expected JSON.
 *
 * It also puts the check AT the boundary. The admin CSV routes previously had
 * no auth code at all -- the only guard lived two files away inside csv.ts, so
 * the authorization property of a public endpoint was not visible in the
 * endpoint. Any refactor of that helper silently opened both routes.
 *
 * Returns either `{ session }` or `{ response }`; callers return the response.
 */
export async function requireApiRole(
  roles: readonly RoleName[],
): Promise<{ session: Session; response?: never } | { session?: never; response: NextResponse }> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  if (!hasAnyRole(session.user.role, roles)) {
    return { response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { session };
}

/** Session-only variant for endpoints open to any signed-in user. */
export async function requireApiSession(): Promise<
  { session: Session; response?: never } | { session?: never; response: NextResponse }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  return { session };
}

/**
 * A per-user throttle for an endpoint that writes to the append-only audit
 * log on every call: the 429 (or, when the limiter cannot count, a 503 --
 * fail closed, as lib/rate-limit.ts does) to return, or null to go on.
 */
export async function apiRateLimit(bucket: string, userId: string, limit: number, windowMs: number): Promise<NextResponse | null> {
  try {
    const rl = await rateLimit({ bucket, id: userId, limit, windowMs });
    if (rl.ok) return null;
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: rl.retryAfterMs },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))) } },
    );
  } catch {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }
}
