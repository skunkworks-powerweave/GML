// POST /api/admin/data/[entity]/import → consume CSV body, bulk-insert, return summary.

import { NextResponse } from "next/server";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { importCsv } from "@/app/(authenticated)/admin/data/[entity]/csv";
import { requireApiRole } from "@/lib/api-guards";

export async function POST(req: Request, ctx: { params: Promise<{ entity: string }> }) {
  const { entity } = await ctx.params;

  const registered = Object.prototype.hasOwnProperty.call(ADMIN_ENTITIES, entity)
    ? ADMIN_ENTITIES[entity]
    : undefined;

  // Bulk row insert. This endpoint had NO auth code: its only guard was
  // csv.ts's requireRole(mutateRolesFor(entity)), and because roles were
  // compared by rank, `sessions` (mutateRoles included "teacher", rank 1)
  // admitted every authenticated user. The proxy matcher covers no /api/* path,
  // so nothing upstream caught it either.
  const gate = await requireApiRole(registered?.mutateRoles ?? registered?.readRoles ?? []);
  if (gate.response) return gate.response;

  if (!registered) {
    return NextResponse.json({ error: "unknown_entity" }, { status: 404 });
  }

  const csv = await req.text();
  if (!csv.trim()) {
    return NextResponse.json({ error: "empty_csv" }, { status: 400 });
  }

  const result = await importCsv(entity, csv);
  return NextResponse.json(result, { status: result.ok ? 200 : 207 /* Multi-Status */ });
}
