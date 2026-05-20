// Section-gate helpers. Used by middleware (spec 008+009) and the gate-prompt
// page (spec 009).

import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@gml/db";
import { sectionGates, sectionGateGrants } from "@gml/db/schema";

export type GateSlug = "mentorship" | "observation" | "tkt" | "ttt";

export const GATED_PREFIXES: { prefix: string; slug: GateSlug }[] = [
  { prefix: "/mentorship", slug: "mentorship" },
  { prefix: "/observation", slug: "observation" },
  { prefix: "/rtt/tkt", slug: "tkt" },
  { prefix: "/rtt/ttt", slug: "ttt" },
];

export function gateForPath(pathname: string): GateSlug | null {
  const hit = GATED_PREFIXES.find(
    (p) => pathname === p.prefix || pathname.startsWith(p.prefix + "/"),
  );
  return hit?.slug ?? null;
}

/** Returns the current grant if any; null otherwise. */
export async function getActiveGrant(userId: string, slug: GateSlug) {
  const [row] = await db
    .select()
    .from(sectionGateGrants)
    .where(
      and(
        eq(sectionGateGrants.userId, userId),
        eq(sectionGateGrants.gateSlug, slug),
        gt(sectionGateGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sectionGateGrants.expiresAt))
    .limit(1);
  return row ?? null;
}

/** Returns the current active gate password row (latest version). */
export async function getCurrentGate(slug: GateSlug) {
  const [row] = await db
    .select()
    .from(sectionGates)
    .where(eq(sectionGates.slug, slug))
    .orderBy(desc(sectionGates.version))
    .limit(1);
  return row ?? null;
}
