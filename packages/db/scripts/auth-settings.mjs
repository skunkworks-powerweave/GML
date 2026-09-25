// Supabase Auth project settings that no migration can see or change, checked
// through GoTrue's public settings endpoint. Imported by verify-auth.mjs; a
// module of its own so tests/behaviour/auth-settings-check.test.ts can execute
// it against a stand-in without a database.
//
// PUBLIC SIGN-UP. Supabase leaves "Allow new users to sign up" ON. The profile
// trigger makes a self-registered account inert, which is why this looked
// harmless -- but anyone holding the publishable key (every signed-in user
// receives it for uploads) can still:
//
//   * pre-register a staff address before an administrator creates it, so the
//     administrator's createUser fails with "already registered";
//   * appear in /admin/users as an ordinary deactivated teacher, where pressing
//     Reactivate hands the stranger an active account in that person's name;
//   * probe POST /auth/v1/signup, which answers 422 user_already_exists for
//     real addresses -- the membership oracle the login and forgot flows avoid.
//
// Accounts in this product are created by administrators (admin.createUser
// keeps working with sign-up disabled), so the switch goes OFF.

/**
 * @param {{ url: string, anonKey: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<Array<{ ok: boolean, label: string, detail?: string, fix?: string }>>}
 */
export async function checkAuthSettings({ url, anonKey, fetchImpl = fetch }) {
  const label = "public sign-up is disabled";
  let settings;
  try {
    const r = await fetchImpl(`${url.replace(/\/+$/, "")}/auth/v1/settings`, { headers: { apikey: anonKey } });
    if (!r.ok) throw new Error(`GET /auth/v1/settings returned HTTP ${r.status}`);
    settings = await r.json();
  } catch (err) {
    return [
      {
        ok: false,
        label,
        detail: `could not read the Auth settings: ${String(err).slice(0, 160)}`,
        fix: "check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      },
    ];
  }

  return [
    settings?.disable_signup === true
      ? { ok: true, label }
      : {
          ok: false,
          label,
          detail:
            "anyone with the publishable key can register any address, squat a staff member's " +
            "account before it is created, and test which addresses exist",
          fix: "Dashboard -> Authentication -> Sign In / Providers -> turn OFF 'Allow new users to sign up'",
        },
  ];
}
