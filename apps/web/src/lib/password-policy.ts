// The application's password policy: ONE definition, used by every path that
// sets a password -- /login/reset, /settings, and /admin/users (create and
// set). It used to be four copies of `const MIN_PASSWORD_LENGTH = 8`, with no
// upper bound anywhere.
//
// WHAT THIS IS NOT. It is not the auth server's policy. A signed-in user can
// call GoTrue's user endpoint directly with their own session, and GoTrue
// applies ITS settings (default minimum: 6). README-deploy §2.2 has the
// dashboard settings that make GoTrue enforce at least this much, plus the
// leaked-password check this module cannot. It deliberately leaves GoTrue's
// character-class requirements OFF: this module checks none, and GoTrue's
// classes are Latin letters and ASCII digits, so with them on a password
// accepted here -- one in Devanagari or Tibetan script, say -- would fail
// there with a raw English message.
//
// No "server-only": pure, and the client forms may show the same numbers.

/** The minimum this product has always told people to expect. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * GoTrue refuses anything longer (bcrypt reads only the first 72 bytes), so a
 * longer password passed the app's check and then failed at Supabase with a
 * raw message. BYTES, not characters: Devanagari and Tibetan are three bytes
 * per character in UTF-8.
 */
export const MAX_PASSWORD_BYTES = 72;

/** Why `password` is not acceptable, or null when it is. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return `The password is too long: at most ${MAX_PASSWORD_BYTES} characters (fewer in Hindi or Tibetan script).`;
  }
  return null;
}

// ── Passwords somebody else chose ───────────────────────────────────────────
//
// An administrator creates an account WITH a password and hands it over, and
// sets one when someone is locked out. Until the holder picks their own, that
// credential is known to someone else -- and nothing used to make them pick
// one. The flag lives in the auth user's app_metadata: only the service role
// can write it (a user's own session cannot clear it through GoTrue), and
// GoTrue copies app_metadata into every access token, so proxy.ts can see it
// without a query. Set by the admin actions; cleared when the holder sets a
// password themselves (/settings, or a recovery link).

export const MUST_CHANGE_PASSWORD = "must_change_password";

/** Does this token's app_metadata say the password must be changed? */
export function mustChangePassword(appMetadata: unknown): boolean {
  return (
    !!appMetadata &&
    typeof appMetadata === "object" &&
    (appMetadata as Record<string, unknown>)[MUST_CHANGE_PASSWORD] === true
  );
}
