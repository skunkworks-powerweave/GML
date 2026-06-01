// MinIO signed URL helpers. Used by the HLS player route and the PDF viewer.
// Signed URLs are short-lived (5 min) and bound to the requesting user_id + IP.
// MinIO's S3-compatible API accepts presigned GETs natively; we wrap the AWS
// SDK's presigner via `@aws-sdk/s3-request-presigner`.
//
// The signed URL is rendered behind /api/media/[key] so the bucket stays private
// at the network level — only Caddy + the app server can reach MinIO directly.

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
 * Signs an opaque token the app can verify before proxying to MinIO.
 * Format: base64url(<bucket>:<objectKey>:<userId>:<ip>:<expEpoch>).<hmac>
 *
 * Server-side: the /api/media/[token] route calls verifySignedToken(); if
 * valid, it streams the object from MinIO using its internal credentials.
 * The HLS player only sees opaque token URLs; bucket+key never leak to the
 * client side.
 */
export function signMediaToken({ bucket, objectKey, userId, ip, ttlSeconds = 300 }: SignParams): string {
  const secret = process.env.MEDIA_SIGN_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) throw new Error("MEDIA_SIGN_SECRET or AUTH_SECRET must be set");

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${bucket}:${objectKey}:${userId}:${ip}:${exp}`;
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = createHmac(ALG, secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

export type VerifyResult =
  | { ok: true; bucket: string; objectKey: string; userId: string; ip: string; exp: number }
  | { ok: false; reason: "format" | "expired" | "signature" | "ip_mismatch" };

/**
 * Verifies an opaque token. Caller passes the current request's IP; if it
 * differs from the IP that was signed in, the URL is rejected (signed URL
 * stays single-device).
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
  if (fields.length !== 5) return { ok: false, reason: "format" };
  const [bucket, objectKey, userId, ip, expStr] = fields;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: "format" };
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: "expired" };
  if (ip !== currentIp) return { ok: false, reason: "ip_mismatch" };
  return { ok: true, bucket, objectKey, userId, ip, exp };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
