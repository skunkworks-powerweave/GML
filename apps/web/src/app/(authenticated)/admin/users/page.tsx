// /admin/users — account administration.
//
// Closes the launch blocker that there was NO WAY TO CREATE A USER. The only
// `insert(users)` anywhere in the repository was the super-admin bootstrap in
// seed.ts; README-IT answered the onboarding question with a raw `psql UPDATE`.
// Teachers, who are the entire audience, could not be given accounts.
//
// Also surfaces the people who have programme data but no login -- teachers and
// mentors whose `user_id` is null. That list is the actual onboarding backlog,
// and without it the roster and the account list drift apart silently.

import { desc, eq, isNull, and } from "drizzle-orm";
import { db } from "@gml/db";
import { users, teachers, mentors } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import type { RoleName } from "@gml/shared/auth/roles";
import { CreateUserForm } from "./create-user-form";
import { UserRow } from "./user-row";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<RoleName, string> = {
  teacher: "Teacher",
  observer: "Observer",
  mentor: "Mentor",
  programme_admin: "Programme admin",
  super_admin: "Super admin",
};

export default async function AdminUsersPage() {
  await requireRole(["programme_admin", "super_admin"]);
  const session = await auth();
  const actorId = session?.user.id ?? "";
  const actorRole = (session?.user.role ?? "teacher") as RoleName;

  // SM-9: opening a surface that lists every account email is itself worth
  // recording, for the same reason the bulk PII exports are.
  void recordAudit({ action: "admin.user.surface_viewed", entityType: "user" });

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
      phone: users.phone,
      lastSeenAt: users.lastSeenAt,
      createdAt: users.createdAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));

  // The onboarding backlog: programme records with nobody attached.
  // `teachers` names the column fullName; `mentors` names it name. Only ACTIVE
  // records are offered: a retired teacher does not need a login, and listing
  // them would bury the people who do.
  const [unlinkedTeachers, unlinkedMentors] = await Promise.all([
    db
      .select({ id: teachers.id, name: teachers.fullName })
      .from(teachers)
      .where(and(isNull(teachers.userId), eq(teachers.active, true)))
      .orderBy(teachers.fullName)
      .limit(500),
    db
      .select({ id: mentors.id, name: mentors.name })
      .from(mentors)
      .where(isNull(mentors.userId))
      .orderBy(mentors.name)
      .limit(500),
  ]);

  const activeCount = rows.filter((r) => r.active && !r.deletedAt).length;

  return (
    <main style={{ padding: "24px 28px", maxWidth: 1100 }}>
      <header style={{ marginBottom: 20 }}>
        <div className="label">Administration</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>Users</h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>
          {activeCount} active {activeCount === 1 ? "account" : "accounts"} of {rows.length}.
          Accounts are created with a password you set and hand over directly — this
          deployment does not send email. The account holder changes it from Settings.
        </p>
      </header>

      <section
        style={{
          border: "1px solid var(--line)",
          borderRadius: "var(--r-2, 8px)",
          padding: 18,
          marginBottom: 28,
          background: "var(--card)",
        }}
      >
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>Create an account</h2>
        <CreateUserForm
          actorRole={actorRole}
          unlinkedTeachers={unlinkedTeachers}
          unlinkedMentors={unlinkedMentors}
        />
      </section>

      <section>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>All accounts</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((u) => (
            <UserRow
              key={u.id}
              user={{
                id: u.id,
                email: u.email,
                name: u.name,
                role: u.role as RoleName,
                active: u.active,
                phone: u.phone,
                deleted: u.deletedAt !== null,
                lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
              }}
              roleLabel={ROLE_LABELS[u.role as RoleName]}
              actorRole={actorRole}
              isSelf={u.id === actorId}
            />
          ))}
        </div>
      </section>

      {unlinkedTeachers.length + unlinkedMentors.length > 0 ? (
        <section style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 15, marginBottom: 6 }}>Awaiting an account</h2>
          <p style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10, lineHeight: 1.5 }}>
            These people have programme records but no login. Creating an account above and
            selecting them from the &ldquo;Link to&rdquo; list attaches the two, so their
            submissions and their sign-in are the same person.
          </p>
          <p style={{ fontSize: 13 }}>
            {unlinkedTeachers.length} {unlinkedTeachers.length === 1 ? "teacher" : "teachers"},{" "}
            {unlinkedMentors.length} {unlinkedMentors.length === 1 ? "mentor" : "mentors"}.
          </p>
        </section>
      ) : null}
    </main>
  );
}
