// POST /api/admin/data/[entity]/import → consume CSV body, bulk-insert, return summary.

import { NextResponse } from "next/server";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { entityGateOpen } from "@/admin/access";
import { importCsv } from "@/app/(authenticated)/admin/data/[entity]/csv";
import { requireApiRole } from "@/lib/api-guards";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** The body as text, or null once it passes `max` bytes (reading stops there). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

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

  // Same section-password rule as the export (admin/access.ts): an import is
  // a bulk write into the gated rows.
  if (!(await entityGateOpen(registered, gate.session.user.id))) {
    return NextResponse.json({ error: "gate_required", gate: registered.gate }, { status: 403 });
  }

  // BOUNDED. The body was read whole, whatever its size, into a process on a
  // box sized for 8 GiB total. 5 MB is roughly 50,000 learner rows -- far past
  // any real roster file -- and a declared length is refused before reading;
  // a chunked body is read up to the cap and no further.
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: "too_large", maxBytes: MAX_IMPORT_BYTES }, { status: 413 });
  }
  const csv = Number.isFinite(declared) ? await req.text() : await readCapped(req, MAX_IMPORT_BYTES);
  if (csv === null || Buffer.byteLength(csv) > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: "too_large", maxBytes: MAX_IMPORT_BYTES }, { status: 413 });
  }
  if (!csv.trim()) {
    return NextResponse.json({ error: "empty_csv" }, { status: 400 });
  }

  const result = await importCsv(entity, csv);
  return NextResponse.json(result, { status: result.ok ? 200 : 207 /* Multi-Status */ });
}
