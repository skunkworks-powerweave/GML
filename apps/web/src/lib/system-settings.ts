// system-settings — request-scoped loader for the singleton system_settings row.
//
// Spec 168 (Workflow Run 16 post-audit hardening): spec 124 created the
// /admin/system-settings page + the system_settings table, but the values
// stored there were never CONSUMED in the UI. This loader wires the row into
// the three real consumers: the upload modal's quality explainer, the
// chrome notification bell's per-kind filter, and the admin home header.
//
// We wrap the SELECT in `React.cache(...)` so a single layout render that
// passes the settings into multiple server components (e.g. the layout's
// notification filter + the admin page header) shares one DB round-trip.
// The cache key is implicit (the function takes no args — there is only
// one row by design, see the system_settings_singleton CHECK constraint).
//
// Fail-shape: any thrown error from the underlying SELECT (DB down, schema
// drift) returns `null` so a caller can fall back to hardcoded defaults
// without crashing the page. The error is logged via console.error so the
// platform team can see it.

import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import {
  systemSettings,
  SYSTEM_SETTINGS_ID,
  type SystemSettings,
} from "@gml/db/schema";

/**
 * Per-request cached fetch of the singleton system_settings row. Returns
 * `null` when the row doesn't exist (pre-bootstrap deployment) or when the
 * SELECT throws (DB unreachable). Callers MUST handle `null` by falling
 * back to whatever literal default they consumed before spec 168 wired
 * this loader in.
 */
export const getSystemSettings = cache(
  async (): Promise<SystemSettings | null> => {
    try {
      const rows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.id, SYSTEM_SETTINGS_ID))
        .limit(1);
      return rows[0] ?? null;
    } catch (err) {
      console.error("[system-settings] getSystemSettings failed", err);
      return null;
    }
  },
);
