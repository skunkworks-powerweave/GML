// GET /api/admin/data/mentors/export — bulk CSV export of mentors with
// active-pairings count joined in.
//
// Spec 160 (Workflow Run 15 audit-closure MISS): /repo/mentors had no CSV
// download button. Schools, teachers, and learners all do; mentors was the
// last index page in the repository slice that didn't. This route is the
// download target.
//
// The generic /api/admin/data/[entity]/export route uses the entity's
// `displayColumns` as CSV headers — for mentors those are [name, bio,
// active]. The audit closure spec calls for a richer column set
// (id, name, hindiName, baseLocation, expertiseAreas, pairingsActive) that
// includes a JOIN-driven pairings count. The generic SELECT pattern can't
// express that, so this is a dedicated route mirroring the learners
// export pattern (apps/web/src/app/api/admin/learners/export/route.ts).
//
// Method matrix:
//   GET                            → 200 text/csv
//   GET (no session)               → 401 {error:"unauthenticated"}
//   GET (role outside allowlist)   → 403 {error:"forbidden"}
//   POST / PUT / DELETE / PATCH    → 405 {error:"method_not_allowed"}
//
// Role gate (deliberately wider than the learners SM-9 super_admin-only
// gate): super_admin OR programme_admin. Mentors are NOT PII-restricted
// the same way learners are — mentors are programme staff, not children.
// The mentor entity's `readRoles` registry entry mirrors this (mentor is
// allowed to READ the row, but bulk export is reserved for admins).
//
// Audit (SM-1 standard, not SM-9): one row per request with action
// `mentors.bulk_export`, entityType `mentors`, metadata.rowCount the
// number of rows returned. Best-effort `void recordAudit(...)` so an
// audit-channel hiccup never blocks the user-facing 200.

import { NextResponse } from "next/server";
import Papa from "papaparse";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { mentors, mentorPairings } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["super_admin", "programme_admin"] as const;

export async function GET(_req: Request) {
  // Auth gate — no session → 401 JSON (never redirect from an API route).
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Role gate — super_admin OR programme_admin. `mentor` itself is NOT in
  // the allowlist: a mentor logged in can view the index page (it's their
  // peers) but cannot bulk-export the directory. That gate aligns with
  // SM-1 (bulk export of any admin entity is an admin-only action).
  if (!ALLOWED_ROLES.includes(session.user.role as (typeof ALLOWED_ROLES)[number])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Pairings counts joined per-mentor — restricted to the `active` status so
  // the export reflects current load, not lifetime pairing history. Same
  // pattern as the /repo/mentors index page (page.tsx lines 47-56), kept
  // here as a single round-trip via LEFT JOIN + GROUP BY rather than two
  // separate queries because the export pulls the full mentor table.
  const pairingCounts = db
    .select({
      mentorId: mentorPairings.mentorId,
      pairingsActive: sql<number>`count(*)::int`.as("pairings_active"),
    })
    .from(mentorPairings)
    .where(eq(mentorPairings.status, "active"))
    .groupBy(mentorPairings.mentorId)
    .as("pairing_counts");

  const rows = await db
    .select({
      id: mentors.id,
      name: mentors.name,
      hindiName: mentors.hindiName,
      baseLocation: mentors.baseLocation,
      expertiseAreas: mentors.expertiseAreas,
      pairingsActive: pairingCounts.pairingsActive,
    })
    .from(mentors)
    .leftJoin(pairingCounts, eq(pairingCounts.mentorId, mentors.id))
    .orderBy(asc(mentors.name));

  // Audit AFTER the SELECT so rowCount is accurate. Best-effort `void` so
  // audit-log failure never blocks the user-facing 200.
  void recordAudit({
    action: "mentors.bulk_export",
    entityType: "mentors",
    metadata: {
      rowCount: rows.length,
    },
  });

  // expertiseAreas is jsonb (string[]) on the schema. CSVs can't carry
  // arrays natively — JSON.stringify is the documented convention used by
  // the generic export (apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts
  // line 48: `else if (typeof v === "object") out[k] = JSON.stringify(v);`).
  const data = rows.map((r) => ({
    id: r.id,
    name: r.name,
    hindiName: r.hindiName ?? "",
    baseLocation: r.baseLocation ?? "",
    expertiseAreas: r.expertiseAreas ? JSON.stringify(r.expertiseAreas) : "[]",
    pairingsActive: r.pairingsActive ?? 0,
  }));

  const headers = ["id", "name", "hindiName", "baseLocation", "expertiseAreas", "pairingsActive"];
  const csv = Papa.unparse({ fields: headers, data });

  // YYYY-MM-DD filename — mirrors the generic export at csv.ts line 55.
  const filename = `mentors-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function POST() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}

export async function PUT() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}

export async function DELETE() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}

export async function PATCH() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
