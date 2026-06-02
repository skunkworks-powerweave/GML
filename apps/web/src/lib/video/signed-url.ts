// MinIO signed URL helpers. Used by the HLS player route and the PDF viewer.
// Signed URLs are short-lived (5 min) and bound to the requesting user_id +
// subnet prefix (NOT the exact /32 IP) so cellular learners in Ladakh whose
// device hops between towers mid-playback don't get a 401 a few seconds into
// the lesson.
//
// MinIO's S3-compatible API accepts presigned GETs natively; we wrap the AWS
// SDK's presigner via `@aws-sdk/s3-request-presigner`.
//
// The signed URL is rendered behind /api/media/[key] so the bucket stays private
// at the network level — only Caddy + the app server can reach MinIO directly.
//
// Spec 145 — IP binding is /24 (IPv4) / /64 (IPv6), not /32. See research.md
// for the threat-model trade-off (exact identity → carrier-grade-NAT stability).

import { createHmac } from "node:crypto";

const ALG = "sha256";

type SignParams = {
  bucket: string;
  objectKey: string;
  userId: string;
  ip: string;
  ttlSeconds?: number; // default 5 minutes
};

/**
 * Returns the binding key for an IP address. For IPv4 we keep the first
 * three octets (the /24 prefix) and drop the host octet so a learner whose
 * device gets a fresh DHCP lease or roams between Reliance Jio / Airtel
 * towers inside the same /24 still validates. For IPv6 we keep the first
 * four hextets (the /64 prefix), which is the standard end-site allocation
 * boundary for almost every consumer ISP — a phone that switches between
 * Wi-Fi and cellular within the same end-site still validates, while a
 * cross-ISP hop (rare during a 5-minute token TTL) still rejects.
 *
 * IPv4 example:  "203.0.113.42"     → "203.0.113"
 * IPv6 example:  "2001:db8:1::abcd" → "2001:db8:1:0"
 * Unknown:       "unknown"          → "unknown"   (preserves backward-compat
 *                                                  with /api/media/[token]'s
 *                                                  "unknown" fallback when no
 *                                                  proxy header is present).
 */
export function ipToBindKey(ip: string): string {
  if (!ip || ip === "unknown") return ip || "unknown";
  // IPv4: dotted quad. Three dots → four octets.
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length !== 4) return ip; // malformed → bind to whole string
    return parts.slice(0, 3).join(".");
  }
  // IPv6: colon-separated. Expand the `::` shorthand so we can reliably take
  // the first four hextets. We don't need to fully canonicalise (e.g. drop
  // leading zeros) — both sign and verify run the SAME function, so any
  // representation differences cancel out as long as they're deterministic.
  if (ip.includes(":")) {
    // Strip IPv4-in-IPv6 zone identifier if present ("fe80::1%eth0").
    const noZone = ip.split("%")[0];
    // Expand "::" to enough ":0:" groups to make 8 hextets total.
    let expanded = noZone;
    if (expanded.includes("::")) {
      const [left, right] = expanded.split("::");
      const leftParts = left ? left.split(":") : [];
      const rightParts = right ? right.split(":") : [];
      const missing = 8 - leftParts.length - rightParts.length;
      const zeros = Array(Math.max(0, missing)).fill("0");
      expanded = [...leftParts, ...zeros, ...rightParts].join(":");
    }
    const parts = expanded.split(":");
    if (parts.length < 4) return ip; // malformed → bind to whole string
    return parts.slice(0, 4).map((p) => p || "0").join(":");
  }
  // Neither v4 nor v6 → bind to the raw string (e.g. "unknown", "loopback").
  return ip;
}

/**
 * Signs an opaque token the app can verify before proxying to MinIO.
 * Format: base64url(<bucket>:<objectKey>:<userId>:<ipBindKey>:<expEpoch>).<hmac>
 *
 * Server-side: the /api/media/[token] route calls verifySignedToken(); if
 * valid, it streams the object from MinIO using its internal credentials.
 * The HLS player only sees opaque token URLs; bucket+key never leak to the
 * client side.
 *
 * The `ip` field we receive is the raw client IP; we collapse it to the
 * subnet prefix via `ipToBindKey` before HMAC'ing, and the verifier does
 * the same to whatever IP the proxied request arrived with. A subnet-level
 * hop (rare during a 5-minute token TTL — would require switching ISPs
 * mid-playback) still rejects.
 */
export function signMediaToken({ bucket, objectKey, userId, ip, ttlSeconds = 300 }: SignParams): string {
  const secret = process.env.MEDIA_SIGN_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) throw new Error("MEDIA_SIGN_SECRET or AUTH_SECRET must be set");

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const bindKey = ipToBindKey(ip);
  const payload = `${bucket}:${objectKey}:${userId}:${bindKey}:${exp}`;
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = createHmac(ALG, secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

export type VerifyResult =
  | { ok: true; bucket: string; objectKey: string; userId: string; ip: string; exp: number }
  | { ok: false; reason: "format" | "expired" | "signature" | "ip_mismatch" };

/**
 * Verifies an opaque token. Caller passes the current request's IP; we
 * collapse it to the same /24 (IPv4) / /64 (IPv6) bind key the signer
 * used and compare in constant time. If the prefix differs from the
 * one that was signed in, the URL is rejected.
 *
 * The verifier accepts EITHER a raw IP or a pre-computed bind key — the
 * proxy route is the canonical caller and it already passes
 * `ipToBindKey(request.ip)` explicitly. Passing the raw IP also works
 * (we ipToBindKey it here too) so callers in tests don't have to
 * remember the contract.
 */
export function verifySignedToken(token: string, currentIp: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "format" };
  const [payloadB64, sig] = parts;

  const secret = process.env.MEDIA_SIGN_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) return { ok: false, reason: "signature" };
  const expectedSig = createHmac(ALG, secret).update(payloadB64).digest("base64url");
  if (!timingSafeEqual(sig, expectedSig)) return { ok: false, reason: "signature" };

  const decoded = Buffer.from(payloadB64, "base64url").toString();
  const fields = decoded.split(":");
  // IPv6 bind keys contain ":" themselves (e.g. "2001:db8:1:0") so the
  // payload format has more than 5 colon-separated fields when an IPv6
  // address was signed. We anchor on the known-fixed slots: bucket and
  // objectKey are the first two; expEpoch is the LAST; userId is the
  // third; everything in between is the bind key.
  if (fields.length < 5) return { ok: false, reason: "format" };
  const bucket = fields[0];
  const objectKey = fields[1];
  const userId = fields[2];
  const expStr = fields[fields.length - 1];
  const bindKey = fields.slice(3, fields.length - 1).join(":");
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: "format" };
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: "expired" };
  const currentBindKey = ipToBindKey(currentIp);
  if (!timingSafeEqual(bindKey, currentBindKey)) return { ok: false, reason: "ip_mismatch" };
  return { ok: true, bucket, objectKey, userId, ip: bindKey, exp };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
