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
import { users } from "@gml/db/schema";
import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { revokeAllSessions, type RevokeResult } from "@/lib/supabase/sessions";
import { recordAudit, noteAuditDegraded } from "@/lib/audit";
import { isRoleName, type RoleName } from "@gml/shared/auth/roles";
import { MUST_CHANGE_PASSWORD, passwordPolicyError } from "@/lib/password-policy";
import { linkAccountToRecord } from "./link";

export type UserActionState = { error?: string; ok?: string };

/** The "Link to" record was claimed by another login first. */
class AlreadyLinked extends Error {}

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
  const policy = passwordPolicyError(password);
  if (policy) return { error: `Initial password: ${policy}` };

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    // Without this GoTrue treats the address as unconfirmed and refuses
    // password sign-in -- the account would exist, look right, and not work.
    // There is no confirmation email to wait for: SMTP is deferred.
    email_confirm: true,
    user_metadata: { name },
    // The administrator knows this password; the holder must replace it
    // before using the site (lib/password-policy.ts, enforced in proxy.ts).
    app_metadata: { [MUST_CHANGE_PASSWORD]: true },
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
      // Claim the record only if nobody holds it (./link.ts). Losing the race
      // is not an overwrite: the new account is undone below and the admin is
      // told, rather than silently taking someone else's programme data.
      if (!(await linkAccountToRecord(db as never, linkKind, linkId, newId))) {
        throw new AlreadyLinked();
      }
    }
  } catch (err) {
    const leftBehind = await rollbackNewAccount(admin, newId, email);
    if (err instanceof AlreadyLinked) {
      return {
        error: `That ${linkKind} record is already linked to another login. ${
          leftBehind ?? "Nothing was created; reload the page for the current list."
        }`,
      };
    }
    // The auth record exists but the profile is wrong. Leaving it would produce
    // an account that can authenticate with the password the administrator
    // chose -- possibly already promoted to the requested role -- so undo it and
    // report honestly rather than leaving an orphan.
    return { error: `Could not set up the profile: ${String(err).slice(0, 200)}. ${leftBehind ?? "Nothing was created."}` };
  }

  const wrote = await recordAudit({
    action: "admin.user.create",
    entityType: "user",
    entityId: newId,
    // The linked record too: "which login became which teacher" is exactly
    // what an investigation of a mis-link needs.
    metadata: { email, role, linkKind: linkKind || null, linkId: linkId || null },
  });
  if (!wrote) noteAuditDegraded("admin/users/createUserAction");

  revalidatePath("/admin/users");
  return {
    ok: `Created ${email}. Give them the password you set; they will be asked to choose their own when they first sign in.`,
  };
}

/**
 * Undo an account createUserAction made and could not finish. Never throws.
 * Returns null when nothing is left, or a sentence telling the administrator
 * what is and where to remove it.
 *
 * Profile first: the on_auth_user_created trigger always writes one, and
 * public.users.id references auth.users ON DELETE RESTRICT (_post/003), so the
 * login cannot go while it exists. And auth-js RETURNS a failed deleteUser as
 * {error} rather than throwing, so the result is checked: the
 * `.catch(() => undefined)` this used to carry could never fire, and a failed
 * rollback still reported "Nothing was created".
 */
async function rollbackNewAccount(
  admin: ReturnType<typeof supabaseAdmin>,
  newId: string,
  email: string,
): Promise<string | null> {
  try {
    await db.execute(sql`DELETE FROM public.users WHERE id = ${newId}::uuid`);
  } catch (err) {
    console.error(`[admin/users] could not remove the profile of the half-created account ${newId}:`, err);
    return `The account for ${email} could not be removed and is still listed here; deactivate it if it is active.`;
  }
  try {
    const { error } = await admin.auth.admin.deleteUser(newId);
    if (error) throw error;
    return null;
  } catch (err) {
    console.error(`[admin/users] could not remove the half-created login ${newId}:`, err);
    return `The login for ${email} could not be removed; delete it in the Supabase dashboard (Authentication → Users) before creating it again.`;
  }
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
  // No "try again": the role change has committed, so pressing Set role again
  // compares the new role with itself, is no demotion, and revokes nothing
  // (the same reason setActiveAction offers no retry). What is true: auth()
  // already refuses their administrator claim, a surviving session can only
  // be renewed as the new role, and deactivating always ends every session.
  return {
    ok:
      revoked && !revoked.ok
        ? `Role updated to ${role}. Their administrator access has ended, but their existing sessions could not be ended: they stay signed in as ${role} until they sign out. To end those sessions, deactivate and reactivate the account.`
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
    revoked = await revokeAllSessions(targetId);
  }
  // Applied on deactivation, lifted on reactivation -- without the lift, a
  // reactivated account is still refused at sign-in with user_banned.
  const ban = await setSignInBan(targetId, !active);

  const wrote = await recordAudit({
    action: active ? "admin.user.activate" : "admin.user.deactivate",
    entityType: "user",
    entityId: targetId,
    metadata: active
      ? { role: permitted.targetRole, banLifted: ban.ok }
      : { role: permitted.targetRole, ...sessionsOutcome(revoked), banApplied: ban.ok },
  });
  if (!wrote) noteAuditDegraded("admin/users/setActiveAction");

  revalidatePath("/admin/users");
  if (active) {
    return {
      ok: ban.ok
        ? "Account reactivated."
        : `Account reactivated, but Supabase still blocks their sign-in (${ban.error}). Deactivate and reactivate them to retry.`,
    };
  }
  // No "deactivate again to retry": the row now offers only Reactivate. The
  // inactive profile is what matters most -- the access-token hook refuses to
  // mint for it, so a session that survived cannot be renewed and a sign-in
  // that got past a missing ban still gets no token.
  const sessions = revoked?.ok
    ? "Account deactivated. Existing sessions ended; their current page may work for up to one token lifetime."
    : "Account deactivated, but their existing sessions could not be ended. They cannot be renewed while the account is inactive and stop working within one token lifetime.";
  return {
    ok: ban.ok
      ? sessions
      : `${sessions} Supabase did not block their sign-in (${ban.error}); the inactive account is still refused a session.`,
  };
}

/**
 * Apply or lift the sign-in ban. Never throws.
 *
 * auth-js RETURNS an API failure as {error} rather than throwing it, so the
 * `.catch(() => undefined)` these calls used to carry could never fire -- the
 * pattern that hid F62's failed revocation. A failed unban reported
 * "Account reactivated." for an account that still could not sign in.
 */
async function setSignInBan(targetId: string, banned: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await supabaseAdmin().auth.admin.updateUserById(targetId, {
      ban_duration: banned ? "876000h" /* ~100 years */ : "none",
    });
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    console.error(`[auth] could not ${banned ? "apply" : "lift"} the sign-in ban for ${targetId}:`, err);
    const message = (err as { message?: unknown } | null)?.message;
    return { ok: false, error: String(typeof message === "string" && message ? message : err).slice(0, 200) };
  }
}

// ── WhatsApp number ───────────────────────────────────────────────────────────

/**
 * A phone number as WhatsApp addresses it: E.164, "+" and 8-15 digits.
 * A bare 10-digit number is an Indian mobile (the programme is in Ladakh);
 * a leading 0 or 91 before one is the same number. null = not a number.
 */
function normalisePhone(raw: string): string | null {
  const s = raw.replace(/[\s\-().]/g, "");
  if (/^\+\d{8,15}$/.test(s)) return s;
  if (/^\d{10}$/.test(s)) return `+91${s}`;
  if (/^0\d{10}$/.test(s)) return `+91${s.slice(1)}`;
  if (/^91\d{10}$/.test(s)) return `+${s}`;
  return null;
}

/**
 * Record (or clear) a staff member's WhatsApp number.
 *
 * WHY THIS EXISTS. /admin/gates offers a rotated section password to "staff
 * with a phone number on file", and nothing in the product wrote users.phone
 * -- no screen, action, import or entity -- so that list was always empty and
 * "Share via WhatsApp" could never be offered. This is the write path.
 *
 * Unlike role and status, a number may be set on your own account: it cannot
 * lock anyone out. programme_admin still cannot edit an administrator.
 */
export async function setPhoneAction(
  _prev: UserActionState | undefined,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await requireAdmin();
  if ("error" in actor) return { error: actor.error };

  const targetId = String(formData.get("userId") ?? "");
  const typed = String(formData.get("phone") ?? "").trim();
  const phone = typed === "" ? null : normalisePhone(typed);
  if (typed !== "" && phone === null) {
    return { error: "Enter a mobile number, e.g. 98765 43210 or +91 98765 43210." };
  }

  if (targetId !== actor.id) {
    const permitted = await canActOn(actor, targetId);
    if (!permitted.ok) return { error: permitted.error };
  }

  const updated = await db
    .update(users)
    .set({ phone, updatedAt: new Date() })
    .where(eq(users.id, targetId))
    .returning({ id: users.id });
  if (updated.length === 0) return { error: "No such user." };

  // Whether a number is on file, not the number: the audit log is readable by
  // every administrator.
  const wrote = await recordAudit({
    action: phone ? "admin.user.phone_set" : "admin.user.phone_cleared",
    entityType: "user",
    entityId: targetId,
  });
  if (!wrote) noteAuditDegraded("admin/users/setPhoneAction");

  revalidatePath("/admin/users");
  return { ok: phone ? `WhatsApp number saved (${phone}).` : "WhatsApp number removed." };
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
  const policy = passwordPolicyError(password);
  if (policy) return { error: policy };

  const permitted = await canActOn(actor, targetId);
  if (!permitted.ok) return { error: permitted.error };

  const admin = supabaseAdmin();
  // Marked for change, as at creation: until the holder chooses their own, the
  // administrator knows it.
  const { error } = await admin.auth.admin.updateUserById(targetId, {
    password,
    app_metadata: { [MUST_CHANGE_PASSWORD]: true },
  });
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
