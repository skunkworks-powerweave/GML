// GET /api/admin/data/[entity]/export → CSV download.

import { NextResponse } from "next/server";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { exportCsv } from "@/app/(authenticated)/admin/data/[entity]/csv";
import { requireApiRole } from "@/lib/api-guards";

export async function GET(_req: Request, ctx: { params: Promise<{ entity: string }> }) {
  const { entity } = await ctx.params;

  // Resolve the entity BEFORE authorizing. getEntityOrThrow() inside csv.ts
  // throws a bare Error for an unknown slug, which surfaced as an unhandled 500
  // — to an unauthenticated caller, and before any auth ran. That made this a
  // working oracle for which admin entities exist. 404 for an unknown slug,
  // after the auth gate, tells an attacker nothing.
  const registered = Object.prototype.hasOwnProperty.call(ADMIN_ENTITIES, entity)
    ? ADMIN_ENTITIES[entity]
    : undefined;

  // The guard lives HERE, at the boundary, not two files away in a page helper.
  // This route previously contained no auth code whatsoever: the only check was
  // csv.ts's requireRole(), which calls redirect() and so answered an API
  // client with a 307 to /forbidden rather than a 403.
  const gate = await requireApiRole(registered?.readRoles ?? []);
  if (gate.response) return gate.response;

  if (!registered) {
    return NextResponse.json({ error: "unknown_entity" }, { status: 404 });
  }

  return exportCsv(entity);
}
