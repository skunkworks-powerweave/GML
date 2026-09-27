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
//
// Every message goes straight back to the administrator's form, so it is in
// their language (admin namespace, users.actions.*). What Supabase itself says
// (a duplicate address, a refused update) is passed through as it comes.

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { eq, and, ne, isNull, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { users } from "@gml/db/schema";
import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { revokeAllSessions, type RevokeResult } from "@/lib/supabase/sessions";
import { recordAudit, noteAuditDegraded } from "@/lib/audit";
import { isRoleName, type RoleName } from "@gml/shared/auth/roles";
import { MUST_CHANGE_PASSWORD } from "@/lib/password-policy";
import { passwordPolicyError } from "@/lib/password-policy-message";
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

/** This module's messages, in the administrator's language. */
async function messages() {
  const t = await getTranslations("admin");
  return {
    t: (key: string, values?: Record<string, string | number>) => t(`users.actions.${key}`, values),
    /** A role as the users page names it, not the enum code. */
    role: (role: string) => (t.has(`client.roles.${role}`) ? t(`client.roles.${role}`) : role),
  };
}

async function requireAdmin(): Promise<Actor | { error: string }> {
  const { t } = await messages();
  const session = await auth();
  if (!session) return { error: t("notSignedIn") };
  const { id, role } = session.user;
  if (role !== "programme_admin" && role !== "super_admin") {
    return { error: t("noPermission") };
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
  const { t } = await messages();
  if (actor.id === targetId) {
    return {
      ok: false,
      error: t("notYourself"),
    };
  }
  const [target] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);

  if (!target) return { ok: false, error: t("noSuchUser") };
  const targetRole = target.role as RoleName;

  if (actor.role !== "super_admin" && (targetRole === "super_admin" || targetRole === "programme_admin")) {
    return { ok: false, error: t("adminOnly") };
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
  const { t } = await messages();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  const password = String(formData.get("password") ?? "");
  // Optional: attach the new account to an existing teachers/mentors record, so
  // the person's programme data and their login are the same person. Without
  // this the roster and the account list drift apart immediately.
  const linkKind = String(formData.get("linkKind") ?? "");
  const linkId = String(formData.get("linkId") ?? "").trim();

  if (!email || !email.includes("@")) return { error: t("invalidEmail") };
  if (!isRoleName(role)) return { error: t("chooseRole") };
  if (!assignableBy(actor.role).includes(role)) {
    return { error: t("cannotAssign") };
  }
  const policy = await passwordPolicyError(password);
  if (policy) return { error: t("initialPassword", { problem: policy }) };

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
    return { error: error?.message ?? t("createFailed") };
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
        error: t("alreadyLinked", {
          kind: linkKind,
          outcome: leftBehind ?? t("nothingCreatedReload"),
        }),
      };
    }
    // The auth record exists but the profile is wrong. Leaving it would produce
    // an account that can authenticate with the password the administrator
    // chose -- possibly already promoted to the requested role -- so undo it and
    // report honestly rather than leaving an orphan.
    return {
      error: t("profileFailed", { detail: String(err).slice(0, 200), outcome: leftBehind ?? t("nothingCreated") }),
    };
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
    ok: t("created", { email }),
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
  const { t } = await messages();
  try {
    await db.execute(sql`DELETE FROM public.users WHERE id = ${newId}::uuid`);
  } catch (err) {
    console.error(`[admin/users] could not remove the profile of the half-created account ${newId}:`, err);
    return t("profileLeftBehind", { email });
  }
  try {
    const { error } = await admin.auth.admin.deleteUser(newId);
    if (error) throw error;
    return null;
  } catch (err) {
    console.error(`[admin/users] could not remove the half-created login ${newId}:`, err);
    return t("loginLeftBehind", { email });
  }
}

// ── role ──────────────────────────────────────────────────────────────────────

export async function setRoleAction(
  _prev: UserActionState | undefined,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await requireAdmin();
  if ("error" in actor) return { error: actor.error };
  const { t, role: roleName } = await messages();

  const targetId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!isRoleName(role)) return { error: t("unknownRole") };
  if (!assignableBy(actor.role).includes(role)) return { error: t("cannotAssign") };

  const permitted = await canActOn(actor, targetId);
  if (!permitted.ok) return { error: permitted.error };

  const result = await db.transaction(async (tx) => {
    if (permitted.targetRole === "super_admin" && role !== "super_admin") {
      if (await wouldStrandTheOrg(tx, targetId)) {
        return { error: t("lastSuperAdmin") };
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
        ? t("roleUpdatedSessionsKept", { role: roleName(role) })
        : t("roleUpdated", { role: roleName(role) }),
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
  const { t } = await messages();

  const targetId = String(formData.get("userId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";

  const permitted = await canActOn(actor, targetId);
  if (!permitted.ok) return { error: permitted.error };

  const result = await db.transaction(async (tx) => {
    if (!active && permitted.targetRole === "super_admin") {
      if (await wouldStrandTheOrg(tx, targetId)) {
        return { error: t("lastSuperAdmin") };
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
        ? t("reactivated")
        : t("reactivatedStillBanned", { error: ban.error }),
    };
  }
  // No "deactivate again to retry": the row now offers only Reactivate. The
  // inactive profile is what matters most -- the access-token hook refuses to
  // mint for it, so a session that survived cannot be renewed and a sign-in
  // that got past a missing ban still gets no token.
  const sessions = revoked?.ok ? t("deactivated") : t("deactivatedSessionsKept");
  return {
    ok: ban.ok
      ? sessions
      : t("banNotApplied", { outcome: sessions, error: ban.error }),
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
  const { t } = await messages();

  const targetId = String(formData.get("userId") ?? "");
  const typed = String(formData.get("phone") ?? "").trim();
  const phone = typed === "" ? null : normalisePhone(typed);
  if (typed !== "" && phone === null) {
    return { error: t("invalidPhone") };
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
  if (updated.length === 0) return { error: t("noSuchUser") };

  // Whether a number is on file, not the number: the audit log is readable by
  // every administrator.
  const wrote = await recordAudit({
    action: phone ? "admin.user.phone_set" : "admin.user.phone_cleared",
    entityType: "user",
    entityId: targetId,
  });
  if (!wrote) noteAuditDegraded("admin/users/setPhoneAction");

  revalidatePath("/admin/users");
  return { ok: phone ? t("phoneSaved", { phone }) : t("phoneRemoved") };
}

// ── password ──────────────────────────────────────────────────────────────────

export async function setPasswordAction(
  _prev: UserActionState | undefined,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await requireAdmin();
  if ("error" in actor) return { error: actor.error };
  const { t } = await messages();

  const targetId = String(formData.get("userId") ?? "");
  const password = String(formData.get("password") ?? "");
  const policy = await passwordPolicyError(password);
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
    ok: revoked.ok ? t("passwordSet") : t("passwordSetSessionsKept"),
  };
}
