// POST /api/admin/data/[entity]/import → consume CSV body, bulk-insert, return summary.

import { NextResponse } from "next/server";
import { importCsv } from "@/app/(authenticated)/admin/data/[entity]/csv";

export async function POST(req: Request, ctx: { params: Promise<{ entity: string }> }) {
  const { entity } = await ctx.params;
  const csv = await req.text();
  if (!csv.trim()) {
    return NextResponse.json({ error: "empty_csv" }, { status: 400 });
  }
  const result = await importCsv(entity, csv);
  return NextResponse.json(result, { status: result.ok ? 200 : 207 /* Multi-Status */ });
}
