"use client";

// Client-side device detection. Confirms server's cookie-based guess via
// matchMedia and updates the cookie if there's a mismatch (so the next
// navigation gets the right shell from the server).

import { useEffect, useState } from "react";
import type { DeviceType } from "./device";

const MOBILE_QUERY = "(max-width: 768px)";

export function useDeviceType(initial: DeviceType = "desktop"): DeviceType {
  const [device, setDevice] = useState<DeviceType>(initial);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const apply = () => {
      const next: DeviceType = mql.matches ? "mobile" : "desktop";
      setDevice(next);
      // Set cookie for next server render.
      document.cookie = `gml-device=${next}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
    };
    apply();
    mql.addEventListener?.("change", apply);
    return () => mql.removeEventListener?.("change", apply);
  }, []);

  return device;
}
