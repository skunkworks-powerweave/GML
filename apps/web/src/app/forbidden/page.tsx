// Forbidden — the 403 / auth-failure landing page.
//
// Spec 170 (Workflow Run 16 post-audit hardening) — the page now renders
// four distinct copy variants driven by `?reason=`. Before this spec the
// page showed one generic "your role does not permit access" message
// regardless of the actual failure cause, which made degraded states
// (locked account, missing SMTP, expired session) indistinguishable from
// genuine role-gate failures.
//
// Reason matrix (the middleware / auth.ts populate the redirect URL
// with `?reason=<x>` when the cause is identifiable):
//
//   reason="locked"             → account locked by failed-login state
//                                  machine (spec 161). Copy mentions
//                                  the 1-hour rolling window and the
//                                  admin contact.
//   reason="smtp_unconfigured"  → the deployment has SMTP_HOST unset,
//                                  so magic-link / forgot-password
//                                  flows are unavailable. Steers the
//                                  user back to credential sign-in.
//   reason="session_expired"    → the JWT aged out (8h maxAge per
//                                  auth.ts). Encourages re-sign-in.
//   default (no reason / unknown) → original "role does not permit"
//                                  copy. Preserves the spec-150
//                                  contract where role-gate failures
//                                  rewrite here with status 403.
//
// The page is a Server Component so it can read `session.user.locked_until`
// (when present) to compute a concrete "try again in <N> minutes" string
// for the locked variant. If the session is absent or doesn't carry
// the column, the fallback is a generic "1 hour" message.
//
// SM-1 audit anchor: the page itself doesn't write to the audit log
// (it's a passive rendering surface). The middleware and auth.ts paths
// that REDIRECT here already write the audit row (e.g.
// `auth.account.locked_attempt` from auth.ts), so SM-1 coverage is
// preserved at the source.

import Link from "next/link";
import { auth } from "@/auth";

type ForbiddenReason = "locked" | "smtp_unconfigured" | "session_expired" | "default";

const KNOWN_REASONS: ForbiddenReason[] = [
  "locked",
  "smtp_unconfigured",
  "session_expired",
];

function resolveReason(raw: string | undefined): ForbiddenReason {
  if (raw && (KNOWN_REASONS as readonly string[]).includes(raw)) {
    return raw as ForbiddenReason;
  }
  return "default";
}

/**
 * Format the "try again in N" hint for the locked variant. Reads
 * `session.user.locked_until` if available (only present on the
 * Credentials provider's `locked` failure path) and computes a
 * human-readable remaining duration. Falls back to "1 hour" when the
 * timestamp is missing or in the past.
 */
function formatTimeRemaining(lockedUntil: Date | null): string {
  if (!lockedUntil) return "1 hour";
  const ms = lockedUntil.getTime() - Date.now();
  if (ms <= 0) return "a moment";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export default async function Forbidden({
  searchParams,
}: {
  searchParams?: Promise<{ reason?: string }>;
}) {
  const sp = searchParams ? await searchParams : {};
  const reason = resolveReason(sp.reason);

  // For the `locked` variant we want a concrete time remaining if we
  // can read it. The session object may not carry locked_until (we
  // don't surface it through the JWT for privacy reasons), so this is
  // best-effort — the fallback string covers the unknown case.
  let lockedUntil: Date | null = null;
  if (reason === "locked") {
    try {
      const session = await auth();
      const raw = (session?.user as { locked_until?: string | Date } | undefined)?.locked_until;
      if (raw) lockedUntil = raw instanceof Date ? raw : new Date(raw);
    } catch {
      // session lookup failure → fall through to the generic message
    }
  }

  let title = "Forbidden";
  let message: string;
  let primaryHref = "/";
  let primaryLabel = "Go home";

  if (reason === "locked") {
    title = "Account locked";
    const timeRemaining = formatTimeRemaining(lockedUntil);
    message = `Your account is temporarily locked due to too many failed login attempts. Try again in ${timeRemaining} or contact your administrator.`;
    primaryHref = "/login";
    primaryLabel = "Back to sign in";
  } else if (reason === "smtp_unconfigured") {
    title = "Email actions unavailable";
    message =
      "Email-based actions (magic-link sign-in, password reset) are not available on this deployment. Use credential sign-in or contact your administrator.";
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
