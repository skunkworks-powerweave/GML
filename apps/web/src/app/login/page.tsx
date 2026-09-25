// Login page entry — a server component that reads getDeviceType() (cookie-first
// with UA fallback, see @/lib/device) and dispatches to DesktopLogin or
// MobileLogin. The split is presentational only; both shells post to the same
// loginAction.
//
// It also resolves the two things the client shells cannot:
//
//   from          proxy.ts puts the originally-requested path in `?from=` so a
//                 user who deep-linked into /observation/<id> lands back there
//                 instead of on the dashboard. The old page took no
//                 searchParams at all and the action hardcoded
//                 redirectTo: "/dashboard", so the parameter proxy had been
//                 setting all along was read by nothing.
//
//   emailEnabled  whether an SMTP relay is configured in Supabase. Kept
//                 server-side deliberately -- see shell-props.ts.
//
//   error         /auth/callback and /auth/confirm send a failed email link
//                 here with ?error=link_expired or link_invalid. The page used
//                 to read neither, so the person landed on a bare sign-in form
//                 with no idea why their link had not worked. Only those two
//                 values are passed on; anything else in the parameter is
//                 dropped, never echoed.
//
// Spec 034 governance contract — the literal Hindi / Ladakhi labels still live
// inside DesktopLogin.tsx, preserved verbatim from the original lift.

import { getDeviceType } from "@/lib/device";
import { authEmailEnabled } from "@/lib/auth-email";
import { DesktopLogin } from "./DesktopLogin";
import { MobileLogin } from "./MobileLogin";
import type { LinkErrorCode } from "./shell-props";

const LINK_ERRORS: readonly LinkErrorCode[] = ["link_expired", "link_invalid"];

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ from?: string; next?: string; error?: string }>;
}) {
  const sp = searchParams ? await searchParams : {};
  const device = await getDeviceType();
  const emailEnabled = authEmailEnabled();

  // Passed through as-is. loginAction re-validates it before redirecting --
  // this value reaches the client, so it must not be trusted on the way back.
  const from = sp.from ?? sp.next ?? "";
  const linkError = LINK_ERRORS.find((code) => code === sp.error);

  return device === "mobile" ? (
    <MobileLogin from={from} emailEnabled={emailEnabled} linkError={linkError} />
  ) : (
    <DesktopLogin from={from} emailEnabled={emailEnabled} linkError={linkError} />
  );
}
