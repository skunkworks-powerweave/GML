import { NextResponse } from "next/server";
import { pingResponse } from "@gml/shared/api-contracts/ping";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = pingResponse.parse({
    pong: true,
    ts: new Date().toISOString(),
    spec: "003",
  });
  return NextResponse.json(payload);
}
