"use client";

// Client-side device detection. Confirms server's cookie-based guess via
// matchMedia and updates the cookie if there's a mismatch (so the next
// navigation gets the right shell from the server).

import { useEffect, useState } from "react";
import type { DeviceType } from "./device";

const MOBILE_QUERY = "(max-width: 768px)";

/**
 * `onFirstMismatch` runs once, on mount, when the viewport disagrees with
 * `initial` (the server's guess). DeviceSync uses it to switch the shell at
 * once; see there for why.
 */
export function useDeviceType(initial: DeviceType = "desktop", onFirstMismatch?: () => void): DeviceType {
  const [device, setDevice] = useState<DeviceType>(initial);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const apply = () => {
      const next: DeviceType = mql.matches ? "mobile" : "desktop";
      setDevice(next);
      // Set cookie for next server render.
      document.cookie = `gml-device=${next}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
      return next;
    };
    if (apply() !== initial) onFirstMismatch?.();
    mql.addEventListener?.("change", apply);
    return () => mql.removeEventListener?.("change", apply);
    // Mount only: `initial` is the server's guess for this document, and the
    // correction is for that guess alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return device;
}
