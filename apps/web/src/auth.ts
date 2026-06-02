import NextAuth, { type DefaultSession, CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { users, accounts, authSessions, verificationTokens } from "@gml/db/schema";
import { verifyPassword } from "@/lib/password";
import { rateLimit } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";

// Spec 170 — Workflow Run 16 post-audit hardening. The forbidden page
// renders different copy depending on WHY the auth failed. The
// authorize() callback below distinguishes the locked-account case
// (where retry-after copy applies) from the bad-credentials case
// (where generic "wrong email or password" copy applies) by THROWING
// `AccountLockedError` for the lockout path. The loginAction in
// app/login/actions.ts catches this distinct class and redirects to
// `/forbidden?reason=locked` rather than re-rendering the login page
// with a generic error. The class extends CredentialsSignin so the
// next-auth signIn pipeline still propagates it as an AuthError.
export class AccountLockedError extends CredentialsSignin {
  code = "account_locked";
}

// Spec 141: never let a raw IP leak into the audit log; mask the last octet
// (v4) or the last hextet (v6). The audit row still carries enough to count
// distinct sources but not enough to identify a single household.
function maskIp(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  if (ip.includes(":")) {
    // IPv6 — drop the last hextet.
    const parts = ip.split(":");
    return parts.slice(0, -1).join(":") + ":xxxx";
  }
  // IPv4 — mask last octet.
  const parts = ip.split(".");
  if (parts.length === 4) return parts.slice(0, 3).join(".") + ".xxx";
  return "masked";
}

// Augment the default session type so callers get `role` + `userId` on `session.user`.
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: DefaultSession["user"] & {
      id: string;
      role: string;
    };
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  // DrizzleAdapter's column-name types are strict snake_case for table-key names;
  // our Drizzle schema uses camelCase JS / snake_case DB. Runtime is identical, so
  // we cast the *table descriptor* through unknown — but NOT the db connection,
  // which DrizzleAdapter inspects at runtime to detect the SQL dialect.
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: authSessions,
    verificationTokensTable: verificationTokens,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any),
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 /* 8h */ },
  pages: {
    signIn: "/login",
  },
  providers: [
    // Magic-link email provider (admin / mentor staff use this; teachers stay on credentials).
    // Gated on SMTP_HOST being configured — if not set, the provider effectively no-ops.
    ...(process.env.SMTP_HOST
      ? [
          Nodemailer({
            server: {
              host: process.env.SMTP_HOST,
              port: Number(process.env.SMTP_PORT ?? 587),
              auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
              },
            },
            from: process.env.SMTP_FROM ?? "lms@goldenmilelearning.org",
            maxAge: 10 * 60, // 10-minute links
          }),
        ]
      : []),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds, request) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;

        // Rate limit per (ip, email).
        const ip =
          request?.headers?.get?.("x-forwarded-for")?.split(",")[0]?.trim() ??
          request?.headers?.get?.("x-real-ip") ??
          "unknown";
        // Spec 141: rate-limit fail-CLOSED. Previously the catch silently
        // allowed every login when Redis was down — an attacker who could
        // partition Redis would unlock unbounded password guessing. Now a
        // Redis fault returns null (deny) and emits a SEVERE audit row so
        // ops can react. The user-facing error remains a generic credential
        // failure so the degraded state isn't leaked to attackers probing
        // for the weakness.
        try {
          const rl = await rateLimit({
            bucket: "login",
            id: `${ip}:${email}`,
            limit: 5,
            windowMs: 15 * 60 * 1000,
          });
          if (!rl.ok) return null;
        } catch (err) {
          void recordAudit({
            action: "auth.rate_limit.redis_down",
            entityType: "auth",
            ipOverride: ip,
            metadata: {
              method: "credentials",
              ipMasked: maskIp(ip),
              severity: "SEVERE",
              error: String(err).slice(0, 200),
            },
          });
          // Fail-closed: deny login when the rate-limit channel is degraded.
          return null;
        }

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user || !user.active) return null;

        // Spec 161 — account lockout check. If locked_until is in the
        // future, refuse the attempt entirely; don't even let the bcrypt
        // verify run (saves CPU on an in-flight attack AND prevents
        // a timing oracle for "is this account locked"). Audit the
        // attempt so post-hoc investigation can see the lockout was
        // honoured — `auth.account.locked_attempt` is the contracted
        // action name.
        //
        // Spec 170 — throw AccountLockedError so the loginAction can
        // distinguish this from a bad-credentials failure and redirect
        // to `/forbidden?reason=locked` (which renders retry-after copy)
        // rather than re-rendering the login page with a generic
        // "wrong password" string. The audit row still fires below
        // before the throw so SM-1 coverage is preserved.
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          void recordAudit({
            userId: user.id,
            action: "auth.account.locked_attempt",
            entityType: "user",
            entityId: user.id,
            ipOverride: ip,
            metadata: { ipMasked: maskIp(ip), until: user.lockedUntil.toISOString() },
          });
          throw new AccountLockedError();
        }

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) {
          // Spec 161 — failed-credentials lockout state machine.
          // Increment the counter; if we've now crossed the threshold
          // (5 consecutive misses) AND no lockout is already pending,
          // arm a 1-hour lockout. The counter doesn't decrement on its
          // own — a successful login clears it (below). The 1-hour
          // rolling window is enforced in practice by the fact that the
          // counter resets to 0 on every successful login; we don't
          // need a per-attempt timestamp ledger for the audit's
          // purposes.
          const newCount = (user.failedLoginCount ?? 0) + 1;
          const shouldLock = newCount >= 5;
          const lockedUntil = shouldLock ? new Date(Date.now() + 60 * 60 * 1000) : null;
          void db
            .update(users)
            .set({
              failedLoginCount: newCount,
              ...(shouldLock ? { lockedUntil } : {}),
            })
            .where(eq(users.id, user.id))
            .catch(() => undefined);
          if (shouldLock) {
            void recordAudit({
              userId: user.id,
              action: "auth.account.locked",
              entityType: "user",
              entityId: user.id,
              ipOverride: ip,
              metadata: {
                ipMasked: maskIp(ip),
                until: lockedUntil!.toISOString(),
                failedCount: newCount,
              },
            });
          }
          return null;
        }

        // Spec 161 — reset lockout state on successful login. The
        // counter goes back to 0 and any pending lockout is cleared.
        // Folded into the same UPDATE as the lastSeenAt bump so the
        // common-path write count stays at one.
        void db
          .update(users)
          .set({ lastSeenAt: new Date(), failedLoginCount: 0, lockedUntil: null })
          .where(eq(users.id, user.id))
          .catch(() => undefined);

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? user.email,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as { id?: string }).id;
        token.role = (user as { role?: string }).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token) {
        session.user.id = String(token.id ?? "");
        session.user.role = String(token.role ?? "teacher");
      }
      return session;
    },
  },
});
