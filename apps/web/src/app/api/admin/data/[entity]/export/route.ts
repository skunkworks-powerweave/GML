// GET /api/admin/data/[entity]/export → CSV download.

import { NextResponse } from "next/server";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { entityGateOpen, exportRolesFor } from "@/admin/access";
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
  //
  // Administrators among the readers only (admin/access.ts exportRolesFor):
  // readRoles alone let mentors, observers and teachers download whole tables
  // the grid never shows them.
  const gate = await requireApiRole(registered ? exportRolesFor(registered) : []);
  if (gate.response) return gate.response;

  if (!registered) {
    return NextResponse.json({ error: "unknown_entity" }, { status: 404 });
  }

  // The section password, for entities whose rows a section keeps behind one
  // (admin/access.ts). A 403 an API client can branch on, not a redirect.
  if (!(await entityGateOpen(registered, gate.session.user.id))) {
    return NextResponse.json({ error: "gate_required", gate: registered.gate }, { status: 403 });
  }

  return exportCsv(entity);
}
