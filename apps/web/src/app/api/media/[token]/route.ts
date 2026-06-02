// Signed-URL proxy for MinIO objects. Verifies the token + IP binding before
// streaming the object. Bucket never goes public; the client only ever sees
// /api/media/<token>.
//
// Spec 144 — Range header pass-through. HLS.js (the video player on
// /videos/[id]) sends `Range: bytes=...` for every segment fetch so the
// browser can seek without reloading from byte 0. Without forwarding the
// Range to S3 / MinIO we'd return the full object body each time with a
// 200, breaking seek on mobile (low-bandwidth networks die under repeated
// full-segment fetches) and forcing HLS.js to re-buffer from the start.
//
// We pass the incoming Range straight through to GetObjectCommand and
// echo back the 206 Partial Content + Content-Range + Content-Length /
// Accept-Ranges from S3. When no Range header is present we behave as we
// did before (200 + full body) so HLS.js's manifest probes and tools like
// `curl /api/media/<token>` keep working.

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { verifySignedToken, ipToBindKey } from "@/lib/video/signed-url";
import { getMinio, fetchObject } from "@/lib/video/minio";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const hdr = await headers();
  const ip =
    hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    hdr.get("x-real-ip") ??
    "unknown";

  // Spec 145 — bind to the /24 (IPv4) / /64 (IPv6) prefix, not /32. Cellular
  // learners in Ladakh roam between towers mid-playback and the host octet
  // changes every few seconds; the subnet prefix stays stable for the
  // 5-minute token TTL window in practice.
  const v = verifySignedToken(token, ipToBindKey(ip));
  if (!v.ok) {
    return NextResponse.json({ error: "signed_url_invalid", reason: v.reason }, { status: 403 });
  }

  // Spec 144 — read incoming Range header and forward to S3. The header
  // arrives looking like "bytes=0-1023" or "bytes=1024-" (open-ended).
  // S3 / MinIO returns 206 + ContentRange + ContentLength when the Range
  // is satisfiable; we echo those back to the client.
  const range = req.headers.get("range");

  try {
    if (range) {
      const r = await getMinio().send(
        new GetObjectCommand({ Bucket: v.bucket, Key: v.objectKey, Range: range }),
      );
      if (!r.Body) {
        return NextResponse.json({ error: "media_fetch_failed", message: "no body" }, { status: 502 });
      }
      const stream = r.Body.transformToWebStream();
      const respHeaders: Record<string, string> = {
        "Content-Type": r.ContentType ?? "application/octet-stream",
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
        "Accept-Ranges": "bytes",
      };
      if (r.ContentRange) respHeaders["Content-Range"] = r.ContentRange;
      if (r.ContentLength !== undefined) respHeaders["Content-Length"] = String(r.ContentLength);
      return new Response(stream, { status: 206, headers: respHeaders });
    }

    // No Range header — fall back to the original full-body response.
    const { body, contentType } = await fetchObject(v.bucket, v.objectKey);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType ?? "application/octet-stream",
        // HLS playlists must not be cached by intermediaries — they reference
        // segment URLs with their own short-lived tokens.
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
        // Spec 144 — advertise range support so HLS.js / browsers know they
        // can seek even when their first probe is a full GET.
        "Accept-Ranges": "bytes",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: "media_fetch_failed", message: String(err) }, { status: 502 });
  }
}
