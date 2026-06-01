// GET /api/admin/data/[entity]/export → CSV download.

import { exportCsv } from "@/app/(authenticated)/admin/data/[entity]/csv";

export async function GET(_req: Request, ctx: { params: Promise<{ entity: string }> }) {
  const { entity } = await ctx.params;
  return exportCsv(entity);
}
