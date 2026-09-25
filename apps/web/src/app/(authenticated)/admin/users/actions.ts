"use server";

// User administration. This surface exists because there was no way to create a
// user at all: the only `insert(users)` in the entire repository was the
// super-admin bootstrap in seed.ts, and README-IT answered the question with a
// raw `psql UPDATE`. Teachers -- the whole audience of the product -- could not
// be onboarded.
//
// ACCOUNTS ARE CREATED WITH A PASSWORD, NOT AN INVITE EMAIL. Outbound SMTP is
// deferred to IT (see lib/auth-email.ts), so an invite flow would be a button
// that silently does nothing. An administrator sets an initial password and
// hands it over through whatever channel they already use; the account holder
// changes it from /settings. When IT configures SMTP, the invite path can be
// added without changing anything here.

import { revalidatePath } from "next/cache";
import { eq, and, ne, isNull, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { users, teachers, mentors } from "@gml/db/schema";
import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { revokeAllSessions, type RevokeResult } from "@/lib/supabase/sessions";
import { recordAudit, noteAuditDegraded } from "@/lib/audit";
import { isRoleName, type RoleName } from "@gml/shared/auth/roles";

export type UserActionState = { error?: string; ok?: string };

const MIN_PASSWORD_LENGTH = 8;

/**
 * Which roles may the caller hand out?
 *
 * programme_admin can staff the programme but cannot mint administrators --
 * otherwise the distinction between the two admin roles is decorative, and any
 * programme_admin could promote themselves to super_admin in two clicks.
 */
function assignableBy(actor: RoleName): readonly RoleName[] {
  return actor === "super_admin"
    ? (["teacher", "observer", "mentor", "programme_admin", "super_admin"] as const)
    : (["teacher", "observer", "mentor"] as const);
}

type Actor = { id: string; role: RoleName };

async function requireAdmin(): Promise<Actor | { error: string }> {
  const session = await auth();
  if (!session) return { error: "Not signed in." };
  const { id, role } = session.user;
  if (role !== "programme_admin" && role !== "super_admin") {
    return { error: "You do not have permission to manage users." };
  }
  return { id, role };
}

/**
 * May `actor` act on `target`?
 *
 * Two rules, both of which exist to stop an administrator locking the
 * organisation out of its own system:
 *
 *   1. Nobody edits themselves here. Self-deactivation and self-demotion are
 *      the two fastest ways to end up with an LMS nobody can administer, and
 *      neither has a legitimate use -- changing your own password belongs in
 *      /settings.
 *   2. programme_admin cannot touch an administrator. Without this, a
 *      programme_admin could deactivate every super_admin and then be the only
 *      person who could act.
 */
async function canActOn(
  actor: Actor,
  targetId: string,
): Promise<{ ok: true; targetRole: RoleName } | { ok: false; error: string }> {
  if (actor.id === targetId) {
    return {
      ok: false,
      error: "You cannot change your own role or status. Ask another administrator.",
    };
  }
  const [target] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);

  if (!target) return { ok: false, error: "No such user." };
  const targetRole = target.role as RoleName;

  if (actor.role !== "super_admin" && (targetRole === "super_admin" || targetRole === "programme_admin")) {
    return { ok: false, error: "Only a super admin can manage administrator accounts." };
  }
  return { ok: true, targetRole };
}

/**
 * Refuse to remove the last usable super admin.
 *
 * Counted with a SELECT ... FOR UPDATE so two concurrent deactivations cannot
 * each observe "two remain" and both proceed. It is a rare action, so the lock
 * costs nothing, and the failure it prevents is unrecoverable without database
 * access.
 */
async function wouldStrandTheOrg(tx: typeof db, targetId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "super_admin"),
        eq(users.active, true),
        isNull(users.deletedAt),
        ne(users.id, targetId),
      ),
    )
    .for("update");
  return rows.length === 0;
}

// ── create ────────────────────────────────────────────────────────────────────

export async function createUserAction(
  _prev: UserActionState | undefined,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await requireAdmin();
  if ("error" in actor) return { error: actor.error };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  const password = String(formData.get("password") ?? "");
  // Optional: attach the new account to an existing teachers/mentors record, so
  // the person's programme data and their login are the same person. Without
  // this the roster and the account list drift apart immediately.
  const linkKind = String(formData.get("linkKind") ?? "");
  const linkId = String(formData.get("linkId") ?? "").trim();

  if (!email || !email.includes("@")) return { error: "Enter a valid email address." };
  if (!isRoleName(role)) return { error: "Choose a role." };
  if (!assignableBy(actor.role).includes(role)) {
    return { error: "You cannot assign that role." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `The initial password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    // Without this GoTrue treats the address as unconfirmed and refuses
    // password sign-in -- the account would exist, look right, and not work.
    // There is no confirmation email to wait for: SMTP is deferred.
    email_confirm: true,
    user_metadata: { name },
  });

  if (error || !data?.user) {
    // Supabase's duplicate-address message is safe to surface: the caller is an
    // authenticated administrator who can already list every account.
    return { error: error?.message ?? "Could not create the account." };
  }

  const newId = data.user.id;

  try {
    // The on_auth_user_created trigger has already written the profile as an
    // INACTIVE teacher. This promotes it to what the administrator asked for --
    // upsert rather than insert, because the row is already there.
    await db.execute(sql`
      INSERT INTO public.users (id, email, name, role, active, default_locale)
      VALUES (${newId}::uuid, ${email}, ${name || null}, ${role}::public.role, true, 'en')
      ON CONFLICT (id) DO UPDATE
        SET role = EXCLUDED.role,
            name = COALESCE(EXCLUDED.name, public.users.name),
            active = true,
            deleted_at = NULL,
            updated_at = now()
    `);

    if (linkId && (linkKind === "teacher" || linkKind === "mentor")) {
      const table = linkKind === "teacher" ? teachers : mentors;
      await db.update(table).set({ userId: newId }).where(eq(table.id, linkId));
    }
  } catch (err) {
    // The auth record exists but the profile is wrong. Leaving it would produce
    // an account that can authenticate and then be refused a token forever,
    // with no row in this list to fix it from -- so undo the auth record and
    // report honestly rather than leaving an orphan.
    await admin.auth.admin.deleteUser(newId).catch(() => undefined);
    return { error: `Could not set up the profile: ${String(err).slice(0, 200)}` };
  }

  const wrote = await recordAudit({
    action: "admin.user.create",
    entityType: "user",
    entityId: newId,
    metadata: { email, role, linkKind: linkKind || null },
  });
  if (!wrote) noteAuditDegraded("admin/users/createUserAction");

  revalidatePath("/admin/users");
  return { ok: `Created ${email}. Give them the password you set; they can change it in Settings.` };
}

// ── role ──────────────────────────────────────────────────────────────────────

export async function setRoleAction(
  _prev: UserActionState | undefined,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await requireAdmin();
  if ("error" in actor) return { error: actor.error };

  const targetId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!isRoleName(role)) return { error: "Unknown role." };
  if (!assignableBy(actor.role).includes(role)) return { error: "You cannot assign that role." };

  const permitted = await canActOn(actor, targetId);
  if (!permitted.ok) return { error: permitted.error };

  const result = await db.transaction(async (tx) => {
    if (permitted.targetRole === "super_admin" && role !== "super_admin") {
      if (await wouldStrandTheOrg(tx, targetId)) {
        return { error: "This is the last active super admin. Promote someone else first." };
      }
    }
    await tx
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, targetId));
    return {};
  });
  if (result.error) return { error: result.error };

  // The role rides in the JWT, so the change takes effect when the target's
  // access token is next minted -- within one token lifetime, with no
  // per-request database read. A DEMOTION should not wait that long: ending
  // their sessions leaves no refresh token to re-mint with, and auth()
  // confirms an administrative claim against public.users, so the access token
  // they still hold stops carrying admin authority at once.
  const isDemotion =
    (permitted.targetRole === "super_admin" || permitted.targetRole === "programme_admin") &&
    role !== "super_admin" &&
    role !== "programme_admin";
  const revoked = isDemotion ? await revokeAllSessions(targetId) : null;

  const wrote = await recordAudit({
    action: "admin.user.role_change",
    entityType: "user",
    entityId: targetId,
    metadata: { from: permitted.targetRole, to: role, ...sessionsOutcome(revoked) },
  });
  if (!wrote) noteAuditDegraded("admin/users/setRoleAction");

  revalidatePath("/admin/users");
  return {
    ok:
      revoked && !revoked.ok
        ? `Role updated to ${role}, but their existing sessions could not be ended. Try again, or ask them to sign out.`
        : `Role updated to ${role}.`,
  };
}

/**
 * What an audit row says about sessions: only what actually happened. `null`
 * means no revocation was attempted.
 */
function sessionsOutcome(r: RevokeResult | null): { sessionsEnded: boolean; sessionsEndedCount?: number } {
  if (!r || !r.ok) return { sessionsEnded: false };
  return { sessionsEnded: true, sessionsEndedCount: r.ended };
}

// ── activate / deactivate ─────────────────────────────────────────────────────

export async function setActiveAction(
  _prev: UserActionState | undefined,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await requireAdmin();
  if ("error" in actor) return { error: actor.error };

  const targetId = String(formData.get("userId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";

  const permitted = await canActOn(actor, targetId);
  if (!permitted.ok) return { error: permitted.error };

  const result = await db.transaction(async (tx) => {
    if (!active && permitted.targetRole === "super_admin") {
      if (await wouldStrandTheOrg(tx, targetId)) {
        return { error: "This is the last active super admin. Promote someone else first." };
      }
    }
    await tx
      .update(users)
      .set({ active, updatedAt: new Date() })
      .where(eq(users.id, targetId));
    return {};
  });
  if (result.error) return { error: result.error };

  let revoked: RevokeResult | null = null;
  if (!active) {
    // THREE LAYERS, because the profile flag alone leaves the user signed in
    // until their current access token expires:
    //
    //   1. active=false above -- the access-token hook now refuses to mint.
    //   2. revokeAllSessions -- deletes their sessions, and with them the
    //      refresh tokens on every device, so there is nothing left to refresh
    //      WITH -- and nothing to come back to life if they are reactivated.
    //   3. ban -- refuses a fresh sign-in even with the correct password,
    //      so they cannot simply log back in.
    //
    // Residual exposure is the access token already in their browser, which
    // cannot be recalled and dies at its own expiry. That is the honest bound,
    // and it is why the token lifetime matters.
    const admin = supabaseAdmin();
    revoked = await revokeAllSessions(targetId);
    await admin.auth.admin
      .updateUserById(targetId, { ban_duration: "876000h" /* ~100 years */ })
      .catch(() => undefined);
  } else {
    await supabaseAdmin()
      .auth.admin.updateUserById(targetId, { ban_duration: "none" })
      .catch(() => undefined);
  }

  const wrote = await recordAudit({
    action: active ? "admin.user.activate" : "admin.user.deactivate",
    entityType: "user",
    entityId: targetId,
    metadata: active ? { role: permitted.targetRole } : { role: permitted.targetRole, ...sessionsOutcome(revoked) },
  });
  if (!wrote) noteAuditDegraded("admin/users/setActiveAction");

  revalidatePath("/admin/users");
  return {
    ok: active
      ? "Account reactivated."
      : revoked?.ok
        ? "Account deactivated. Existing sessions ended; their current page may work for up to one token lifetime."
        : "Account deactivated, but their existing sessions could not be ended; they stop working within one token lifetime. Deactivate again to retry.",
  };
}

// ── password ──────────────────────────────────────────────────────────────────

export async function setPasswordAction(
  _prev: UserActionState | undefined,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await requireAdmin();
  if ("error" in actor) return { error: actor.error };

  const targetId = String(formData.get("userId") ?? "");
  const password = String(formData.get("password") ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const permitted = await canActOn(actor, targetId);
  if (!permitted.ok) return { error: permitted.error };

  const admin = supabaseAdmin();
  const { error } = await admin.auth.admin.updateUserById(targetId, { password });
  if (error) return { error: error.message };

  // End their sessions. An administrator setting a password is either
  // onboarding someone or responding to a suspected compromise, and in the
  // second case leaving the existing sessions alive defeats the exercise.
  // GoTrue's own admin password update deletes them too; this does not depend
  // on that, and the audit row records what was actually done.
  const revoked = await revokeAllSessions(targetId);

  // The password itself is never audited, in any form -- not the plaintext, not
  // a hash, not a length. The audit log is readable by every administrator.
  const wrote = await recordAudit({
    action: "admin.user.password_set",
    entityType: "user",
    entityId: targetId,
    metadata: { role: permitted.targetRole, ...sessionsOutcome(revoked) },
  });
  if (!wrote) noteAuditDegraded("admin/users/setPasswordAction");

  revalidatePath("/admin/users");
  return {
    ok: revoked.ok
      ? "Password set. Their other sessions have been signed out."
      : "Password set, but their existing sessions could not be ended. Try again, or ask them to sign out.",
  };
}
