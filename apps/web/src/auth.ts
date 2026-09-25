// Session access for the whole application.
//
// This module replaced Auth.js v5 (next-auth beta) with Supabase Auth. The
// EXPORTED SURFACE IS DELIBERATELY UNCHANGED -- `auth()` returns the same
// `{ user: { id, email, name, image, role } }` shape it always did, so the 58
// call sites that read a session did not have to be touched. What changed is
// where the answer comes from.
//
// WHAT WAS WRONG WITH THE OLD IMPLEMENTATION
//
//   * Uncontrolled self-registration. The Nodemailer provider plus
//     DrizzleAdapter auto-created a user row for ANY address that requested a
//     magic link, with role='teacher', active=true, and there was no signIn
//     callback to stop it. It was dormant only because SMTP_HOST was empty.
//   * The magic-link path never checked `users.active`, so a deactivated member
//     of staff could sign straight back in.
//   * The JWT carried role and active for EIGHT HOURS and the session callback
//     never re-read the database, so demotion, deactivation and admin lockout
//     had no effect at all until the token expired.
//   * The hand-rolled lockout (failed_login_count / locked_until) was a DoS in
//     both directions: anyone who knew an address could lock it at will, the
//     counter never decayed so one further guess re-locked it for another hour,
//     and `AccountLockedError` was an account-existence oracle.
//
// HOW THE NEW ONE ANSWERS EACH
//
// `getClaims()` verifies the access token's signature LOCALLY against the
// project's JWKS (this project signs ES256; the key set is fetched once and
// cached), so reading a session costs no network call and no database query --
// the same performance the old JWT had. The one exception is an administrative
// role claim, which is confirmed against public.users (see auth()).
//
// The claims themselves are minted by `public.custom_access_token_hook`
// (packages/db/src/migrations/_post/004). GoTrue calls it on sign-in AND on
// every refresh, and it refuses -- returns 403, mints nothing -- when the
// profile row is missing, inactive, or soft-deleted. That single function is
// what closes all four defects above:
//
//   * missing profile  => self-registration produces an account that cannot
//                         obtain a token, so it cannot load a single page;
//   * inactive profile => deactivation is honoured on the magic-link path too,
//                         because it is checked at mint time, not at provider
//                         time;
//   * re-read per mint => role and active are re-checked every refresh, so the
//                         stale window is one access-token lifetime rather than
//                         eight hours -- and for the two ADMINISTRATIVE roles
//                         there is no stale window at all (see auth() below);
//   * lockout          => deleted outright. Supabase Auth rate-limits sign-in
//                         attempts centrally, with no per-account flag an
//                         attacker can set on someone else's behalf.
//
// FAIL-CLOSED. If the token carries no `user_role` claim, `auth()` returns
// null. That is the correct response to the most likely misconfiguration --
// the access-token hook not being enabled in the dashboard -- because the
// alternative, defaulting to 'teacher', would silently grant a role to
// principals the hook was supposed to reject.

import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { users } from "@gml/db/schema";
import { isRoleName, type RoleName } from "@gml/shared/auth/roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  role: RoleName;
};

export type Session = { user: SessionUser };

/** Empty display claims are encoded as '' by the hook; treat them as absent. */
function orNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The current session, or null.
 *
 * Never throws: a Supabase outage, a malformed cookie and an unauthenticated
 * visitor all produce the same `null`, because every caller already treats null
 * as "not signed in" and redirects. Turning an outage into an unhandled
 * exception inside a layout would render a stack trace instead of /login.
 */
export async function auth(): Promise<Session | null> {
  let claims: Record<string, unknown> | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    claims = data.claims as unknown as Record<string, unknown>;
  } catch {
    return null;
  }

  const id = typeof claims.sub === "string" ? claims.sub : null;
  const role = claims.user_role;

  // Both must be present. `isRoleName` rather than a cast: the claim is
  // attacker-visible in the token, and although the signature check above means
  // it cannot be attacker-CHOSEN, an unrecognised value arriving from a future
  // enum change should fail closed rather than flow into a role comparison.
  if (!id || !isRoleName(role)) return null;

  // An ADMINISTRATIVE claim is confirmed against the profile, every time.
  //
  // The token is verified locally and is honoured until it expires, and
  // nothing can recall one already issued -- ending a user's sessions only
  // stops the NEXT mint. For most roles that window is an acceptable cost of
  // a zero-query session read. For these two it is not: a super_admin demoted
  // at 10:00 kept /admin/users until their token expired, which was long
  // enough to create a replacement super_admin account and make the demotion
  // pointless. Administrators are a handful of people, so the price is one
  // primary-key read per request for them and nothing for the teachers.
  let effectiveRole: RoleName = role;
  if (ADMIN_ROLES.has(role)) {
    const current = await currentRole(id);
    if (!current) return null;
    effectiveRole = current;
  }

  return {
    user: {
      id,
      email: orNull(claims.email),
      name: orNull(claims.user_name),
      image: orNull(claims.user_image),
      role: effectiveRole,
    },
  };
}

const ADMIN_ROLES: ReadonlySet<RoleName> = new Set<RoleName>(["programme_admin", "super_admin"]);

/** How long after following a recovery link it may be used to set a password. */
export const RECOVERY_WINDOW_SECONDS = 15 * 60;

/**
 * Did the current session come from a password-recovery link, recently?
 *
 *   "recovery"      yes, within RECOVERY_WINDOW_SECONDS
 *   "expired"       yes, but longer ago than that
 *   "not_recovery"  a session established some other way (a password, a
 *                   magic link)
 *   "signed_out"    no session
 *
 * WHY /login/reset NEEDS THIS. Setting a password there asks for no current
 * password, which is only acceptable because following the emailed link
 * proved control of the mailbox. The page used to accept ANY session, so an
 * unattended, signed-in school computer was enough to change the owner's
 * password and -- the action then ends every other session -- lock them out
 * everywhere. GoTrue records how a session was authenticated in the token's
 * `amr` claim; a recovery link yields {"method":"recovery","timestamp":...}.
 * The window bounds the same unattended-computer case for a browser that DID
 * follow a recovery link and was then left open.
 */
export async function recoverySessionState(): Promise<"recovery" | "expired" | "not_recovery" | "signed_out"> {
  let amr: unknown;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return "signed_out";
    amr = (data.claims as unknown as Record<string, unknown>).amr;
  } catch {
    return "signed_out";
  }
  const entry = Array.isArray(amr)
    ? (amr as Array<{ method?: unknown; timestamp?: unknown }>).find((a) => a?.method === "recovery")
    : undefined;
  if (!entry) return "not_recovery";
  const at = typeof entry.timestamp === "number" ? entry.timestamp : 0;
  return Date.now() / 1000 - at <= RECOVERY_WINDOW_SECONDS ? "recovery" : "expired";
}

/**
 * The role public.users holds for `id` now, or null when the profile is
 * missing, inactive or soft-deleted -- the same refusals the access-token hook
 * applies at mint time. A failed read is also null: auth() fails closed.
 *
 * cache(): a page render calls auth() from the layout, the page and its guards;
 * within one request this is read once.
 */
const currentRole = cache(async (id: string): Promise<RoleName | null> => {
  try {
    const [row] = await db
      .select({ role: users.role, active: users.active, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!row || !row.active || row.deletedAt || !isRoleName(row.role)) return null;
    return row.role;
  } catch {
    return null;
  }
});

/**
 * Sign in with email + password.
 *
 * Returns an error string rather than throwing, and the string is deliberately
 * the same for every failure mode. Distinguishing "no such account" from "wrong
 * password" -- which the old AccountLockedError path did -- hands an attacker a
 * membership oracle for an organisation whose email addresses are guessable.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<{ error: string | null }> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) return { error: null };

  // A 403 from the access-token hook means the credentials were RIGHT but the
  // account is not permitted a token -- inactive, soft-deleted, or never
  // invited. Saying "incorrect password" to someone whose password was correct
  // sends them to reset it, which will not help. This distinction is safe to
  // surface: the caller already proved they hold the password.
  const status = (error as { status?: number }).status;
  if (status === 403) {
    return { error: "This account is not active. Contact your administrator." };
  }
  if (status === 429) {
    return { error: "Too many sign-in attempts. Wait a few minutes and try again." };
  }
  return { error: "Incorrect email or password." };
}

/**
 * Sign out and redirect.
 *
 * scope 'local' clears this browser's session only. Ending the user's sessions
 * on every device is what the admin deactivate path does (lib/supabase/
 * sessions.ts), and is not what someone clicking "sign out" on a shared school
 * computer expects to happen to their phone.
 */
export async function signOut(opts?: { redirectTo?: string }): Promise<never> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Even if the network call fails, the cookies are cleared by the client's
    // own storage adapter, and the redirect below still takes the user out.
  }
  redirect(opts?.redirectTo ?? "/login");
}
