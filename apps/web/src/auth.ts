import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { users, accounts, authSessions, verificationTokens } from "@gml/db/schema";
import { verifyPassword } from "@/lib/password";
import { rateLimit } from "@/lib/rate-limit";

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
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: authSessions,
    verificationTokensTable: verificationTokens,
  }),
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
        try {
          const rl = await rateLimit({
            bucket: "login",
            id: `${ip}:${email}`,
            limit: 5,
            windowMs: 15 * 60 * 1000,
          });
          if (!rl.ok) return null;
        } catch {
          // If Redis is down, fall back to allowing — don't lock everyone out.
        }

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user || !user.active) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;

        // Bump lastSeenAt fire-and-forget.
        void db
          .update(users)
          .set({ lastSeenAt: new Date() })
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
