// Signed-URL proxy for MinIO objects. Verifies the token + IP binding before
// streaming the object. Bucket never goes public; the client only ever sees
// /api/media/<token>.

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { verifySignedToken } from "@/lib/video/signed-url";
import { fetchObject } from "@/lib/video/minio";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const hdr = await headers();
  const ip =
    hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    hdr.get("x-real-ip") ??
    "unknown";

  const v = verifySignedToken(token, ip);
  if (!v.ok) {
    return NextResponse.json({ error: "signed_url_invalid", reason: v.reason }, { status: 403 });
  }

  try {
    const { body, contentType } = await fetchObject(v.bucket, v.objectKey);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType ?? "application/octet-stream",
        // HLS playlists must not be cached by intermediaries — they reference
        // segment URLs with their own short-lived tokens.
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: "media_fetch_failed", message: String(err) }, { status: 502 });
  }
}
