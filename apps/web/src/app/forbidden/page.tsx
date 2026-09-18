// Forbidden — the 403 / auth-failure landing page.
//
// Renders distinct copy per `?reason=`, because a single generic "your role
// does not permit access" made degraded states indistinguishable from genuine
// role-gate failures -- a user whose session had simply expired was told they
// lacked permission, and went to ask an administrator for a role they already
// had.
//
// Reason matrix:
//
//   reason="rate_limited"       -> Supabase Auth refused further sign-in
//                                  attempts from this source.
//   reason="email_unavailable"  -> outbound email is not configured on this
//                                  deployment (AUTH_EMAIL_ENABLED unset), so
//                                  magic-link and self-service reset are off.
//                                  Steers the user to password sign-in.
//   reason="session_expired"    -> the access token aged out and could not be
//                                  refreshed. Encourages re-sign-in.
//   default                     -> role gate. proxy.ts rewrites here with an
//                                  explicit 403.
//
// THE `locked` VARIANT IS GONE, along with the machinery behind it. This page
// used to call auth() purely to read `session.user.locked_until` and render
// "try again in N minutes". That column no longer exists: the hand-rolled
// lockout it belonged to was a denial-of-service tool -- anyone who knew an
// address could lock it at will, the counter never decayed, so a single further
// guess re-locked it for another hour, indefinitely, at one request per hour.
// Supabase Auth rate-limits sign-in centrally with no per-account flag a
// stranger can set on someone else's behalf. Removing the read also removes a
// session lookup from a page that is, by definition, rendered to people who
// have just failed an authorization check.
//
// SM-1 audit anchor: this page is a passive rendering surface and writes
// nothing. The paths that redirect here write their own audit rows, so SM-1
// coverage is preserved at the source.

import Link from "next/link";

type ForbiddenReason = "rate_limited" | "email_unavailable" | "session_expired" | "default";

const KNOWN_REASONS: ForbiddenReason[] = [
  "rate_limited",
  "email_unavailable",
  "session_expired",
];

function resolveReason(raw: string | undefined): ForbiddenReason {
  if (raw && (KNOWN_REASONS as readonly string[]).includes(raw)) {
    return raw as ForbiddenReason;
  }
  return "default";
}

export default async function Forbidden({
  searchParams,
}: {
  searchParams?: Promise<{ reason?: string }>;
}) {
  const sp = searchParams ? await searchParams : {};
  const reason = resolveReason(sp.reason);

  let title = "Forbidden";
  let message: string;
  let primaryHref = "/";
  let primaryLabel = "Go home";

  if (reason === "rate_limited") {
    title = "Too many attempts";
    message =
      "Too many sign-in attempts from this connection. Wait a few minutes and try again, or contact your administrator.";
    primaryHref = "/login";
    primaryLabel = "Back to sign in";
  } else if (reason === "email_unavailable") {
    title = "Email actions unavailable";
    message =
      "Email-based actions (magic-link sign-in, password reset) are not enabled on this deployment. Sign in with your password, or ask your administrator to set a new one.";
    primaryHref = "/login";
    primaryLabel = "Sign in";
  } else if (reason === "session_expired") {
    title = "Session expired";
    message = "Your session has ended. Please sign in again.";
    primaryHref = "/login";
    primaryLabel = "Sign in";
  } else {
    message = "You don't have permission to view this page.";
  }

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="forbidden-page"
      data-reason={reason}
    >
      <p className="text-5xl">403</p>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-neutral-600">{message}</p>
      <Link
        href={primaryHref}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white"
      >
        {primaryLabel}
      </Link>
    </main>
  );
}
