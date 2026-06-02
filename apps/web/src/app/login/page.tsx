// Login page entry — spec 136 split this from a flat "use client" page into a
// server component that reads getDeviceType() (cookie-first with UA fallback,
// see @/lib/device) and dispatches to either DesktopLogin or MobileLogin.
//
// The Auth.js server actions (loginAction in ./actions) and the Nodemailer
// magic-link path are unchanged across shells — the split is presentational
// only. The route-segment layout (./layout.tsx) still supplies the next-intl
// provider for the chosen pre-auth locale (gml-locale cookie + default 'en').
//
// Spec 034 governance contract — the literal Hindi / Ladakhi labels still
// live inside DesktopLogin.tsx (preserved verbatim from the original lift).

import { getDeviceType } from "@/lib/device";
import { DesktopLogin } from "./DesktopLogin";
import { MobileLogin } from "./MobileLogin";

export default async function LoginPage() {
  const device = await getDeviceType();
  return device === "mobile" ? <MobileLogin /> : <DesktopLogin />;
}
