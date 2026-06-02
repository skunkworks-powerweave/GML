// Spec 161 — POST /api/auth/forgot-password
//
// Contract:
//   — Accept { email: string } JSON body.
//   — Always respond 200 with `{ ok: true }` regardless of whether the
//     email matched a real user (NO ENUMERATION). The only non-200 path
//     is a rate-limit hit (429) or a malformed body (400).
//   — Rate-limit 3 requests / hour / IP via the existing Redis rateLimit
//     helper, bucket = "forgot-password". Fail-CLOSED on Redis down (same
//     contract as the credentials authorize() path, spec 141).
//   — Generate a 32-byte random token via crypto.randomBytes(32). Hex-
//     encode for transmission (64 chars). bcrypt-hash the token at cost 10
//     and store only the hash in password_reset_tokens (the plaintext is
//     embedded in the email body and discarded by this handler).
//   — expiresAt = now() + 30 minutes. requestedFromIp is the MASKED ip so
//     a DB leak doesn't expose per-account IP history.
//   — If SMTP is not configured, the row still gets written (so tests
//     covering the DB write can still assert it) but the email send is a
//     no-op — operators see the audit row and can hand-deliver if needed.
//   — Audit row: `auth.password.reset_requested` with metadata {
//     ipMasked, emailHashed } so the post-hoc investigation can correlate
//     reset attempts to a single email without storing the email in the
//     audit (already governed by spec 010 — audit.metadata is jsonb).

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { users, passwordResetTokens } from "@gml/db/schema";
import { rateLimit } from "@/lib/rate-limit";
import { recordAudit, noteAuditDegraded } from "@/lib/audit";
// Spec 167 — pull the bcrypt cost from the canonical source so a future
// hardening pass (e.g. cost 12) only has to edit lib/password.ts. The local
// `const BCRYPT_COST = 10` that lived here pre-167 was the second of five
// duplicated literals in the codebase and the easiest one to forget to bump.
import { BCRYPT_COST } from "@/lib/password";

const TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 min — spec contract

// Spec 161 — IP masking helper. Mirrors the maskIp() in auth.ts; keep both
// in sync if either changes. We can't import from auth.ts because that
// pulls in NextAuth's edge-incompatible deps; the function is tiny enough
// that duplicating it inline is cheaper than a shared util import.
function maskIp(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return parts.slice(0, -1).join(":") + ":xxxx";
  }
  const parts = ip.split(".");
  if (parts.length === 4) return parts.slice(0, 3).join(".") + ".xxx";
  return "masked";
}

// Spec 161 — opaque email hash for audit correlation. The email itself
// never lands in metadata (spec 010 prohibits PII in audit.metadata for
// auth events); a SHA-256 of the lower-cased email lets investigators
// cluster reset attempts without storing the address.
function hashEmail(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
}

export async function POST(request: Request) {
  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const ipMasked = maskIp(ip);

  // Spec 161 — rate-limit 3/hr per IP. Fail-CLOSED on Redis down (same
  // contract as credentials authorize, spec 141). Without this an attacker
  // who controls a botnet could enumerate emails by burning reset tokens
  // through the no-enumeration response (the absence of 429 would still
  // tell them their request landed).
  try {
    const rl = await rateLimit({
      bucket: "forgot-password",
      id: ip,
      limit: 3,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.ok) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
  } catch (err) {
    void recordAudit({
      action: "auth.rate_limit.redis_down",
      entityType: "auth",
      ipOverride: ip,
      metadata: {
        method: "forgot-password",
        ipMasked,
        severity: "SEVERE",
        error: String(err).slice(0, 200),
      },
    });
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // No-enumeration: respond 200 even when the user doesn't exist. We do
  // still audit the miss so operators see attempted-but-unmatched resets
  // pile up if an attacker is probing.
  if (!user || !user.active) {
    void recordAudit({
      action: "auth.password.reset_requested",
      entityType: "user",
      ipOverride: ip,
      metadata: {
        ipMasked,
        emailHashed: hashEmail(email),
        matched: false,
      },
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // Generate 32 random bytes -> 64-char hex string. crypto.randomBytes is
  // CSPRNG; the entropy budget is plenty for a 30-minute-lived token.
  const plaintextToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = await bcrypt.hash(plaintextToken, BCRYPT_COST);
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt,
    requestedFromIp: ipMasked,
  });

  // Send the email if SMTP is wired up. The link points at the public
  // /login/reset page with the plaintext token in the query string — this
  // is the only place the plaintext ever exists outside the user's inbox.
  const appUrl = process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  const resetUrl = `${appUrl.replace(/\/$/, "")}/login/reset?token=${plaintextToken}`;
  if (process.env.SMTP_HOST) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
          : undefined,
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM ?? "lms@goldenmilelearning.org",
        to: user.email,
        subject: "Goldenmile RTT — Password reset",
        text: `Hello ${user.name ?? "there"},

You (or someone using your email) requested a password reset for your
Goldenmile RTT account. To choose a new password, follow this link
(valid for 30 minutes):

  ${resetUrl}

If you didn't request this, you can safely ignore this email — your
existing password will keep working.

— Goldenmile Learning programme
`,
      });
    } catch (err) {
      // Don't fail the request if email send blows up — the row is
      // already written and an operator can still recover the user.
      console.error("[forgot-password] email send failed", err);
    }
  }

  // Spec 167 — HIGH-STAKES audit: the matched-and-emailed reset is the only
  // record that proves a particular reset link was actually issued. If the
  // insert fails we still keep the 200 response (no-enumeration contract is
  // load-bearing) but we noteAuditDegraded() so an operator can see the gap.
  const auditOk = await recordAudit({
    userId: user.id,
    action: "auth.password.reset_requested",
    entityType: "user",
    entityId: user.id,
    ipOverride: ip,
    metadata: {
      ipMasked,
      emailHashed: hashEmail(email),
      matched: true,
      smtpConfigured: Boolean(process.env.SMTP_HOST),
    },
  });
  if (!auditOk) {
    noteAuditDegraded("/api/auth/forgot-password");
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
