// Device detection for shell selection.
// Server: reads the `gml-device` cookie (set by client effect on first visit).
// Client: confirms via matchMedia and updates the cookie if mismatched.

import { cookies, headers } from "next/headers";

export type DeviceType = "mobile" | "desktop";

const COOKIE_NAME = "gml-device";

/**
 * Server-side: returns the device type for the current request.
 * Falls back to a User-Agent regex sniff if the cookie isn't set yet.
 */
export async function getDeviceType(): Promise<DeviceType> {
  const c = await cookies();
  const fromCookie = c.get(COOKIE_NAME)?.value;
  if (fromCookie === "mobile" || fromCookie === "desktop") return fromCookie;

  // UA fallback for first visit (mobile detection is intentionally generous —
  // the client effect will correct it within a tick).
  const hdr = await headers();
  const ua = (hdr.get("user-agent") ?? "").toLowerCase();
  const isMobileUa =
    /android|iphone|ipod|ipad|opera mini|iemobile|blackberry|windows phone/.test(ua);
  return isMobileUa ? "mobile" : "desktop";
}

export const DEVICE_COOKIE_NAME = COOKIE_NAME;
