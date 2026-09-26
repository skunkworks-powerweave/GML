// scripts/verify-auth.mjs's Supabase Auth settings checks, EXECUTED against
// ./_fake_gotrue.ts's GET /auth/v1/settings.
//
// ── THE DEFECT (F82) ─────────────────────────────────────────────────────────
//
// Public sign-up was left at Supabase's default: ON. The design treated
// self-registration as harmless because the trigger makes the profile
// inactive, and verify-auth only checked that new accounts are inert. But
// anyone with the publishable key -- every signed-in user receives it -- could:
//
//   * pre-register a staff address before the administrator created it, so
//     createUserAction failed with "already registered";
//   * sit in /admin/users as an ordinary "deactivated" teacher, so pressing
//     Reactivate handed the stranger an active account in that person's name;
//   * probe POST /auth/v1/signup, which answers 422 user_already_exists for
//     real staff addresses -- the membership oracle the login and forgot flows
//     were written to avoid.
//
// The switch is a dashboard setting no migration can reach. So the deploy
// verification must FAIL while it is on, the way it fails while the
// access-token hook is off.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeGoTrue, ANON_KEY, type FakeGoTrue } from "./_fake_gotrue.ts";

type Check = { ok: boolean; label: string; detail?: string; fix?: string };
const settingsModule = () =>
  import("../../packages/db/scripts/auth-settings.mjs") as Promise<{
    checkAuthSettings: (o: { url: string; anonKey: string }) => Promise<Check[]>;
    probePassword: () => string;
  }>;

let fake: FakeGoTrue;
before(async () => {
  fake = await fakeGoTrue();
});
after(() => fake.close());

test("verify-auth fails while public sign-up is enabled, and says how to turn it off", async () => {
  const { checkAuthSettings } = await settingsModule();
  fake.setSettings({ disable_signup: false, mailer_autoconfirm: true });
  const checks = await checkAuthSettings({ url: fake.url, anonKey: ANON_KEY });
  const signup = checks.find((c) => /sign-?up/i.test(c.label));
  assert.ok(signup, `expected a sign-up check, got ${JSON.stringify(checks)}`);
  assert.equal(signup!.ok, false, "sign-up enabled must be a FAIL");
  assert.match(signup!.fix ?? "", /Allow new users to sign up/, "the fix names the dashboard switch");
});

test("verify-auth passes the sign-up check once it is disabled", async () => {
  const { checkAuthSettings } = await settingsModule();
  fake.setSettings({ disable_signup: true, mailer_autoconfirm: false });
  const checks = await checkAuthSettings({ url: fake.url, anonKey: ANON_KEY });
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
});

test("an unreadable settings endpoint is a FAIL, not a silent pass", async () => {
  const { checkAuthSettings } = await settingsModule();
  fake.setOutage(503);
  try {
    const checks = await checkAuthSettings({ url: fake.url, anonKey: ANON_KEY });
    assert.ok(checks.length > 0 && checks.some((c) => !c.ok), JSON.stringify(checks));
  } finally {
    fake.setOutage(null);
  }
});

// ── F86: the probe account's password ────────────────────────────────────────
//
// verify-auth creates a throwaway account with admin.createUser, and Supabase
// applies its password policy there too. The probe was `Verify-` plus base36
// from Math.random(), which has no digit about one run in fifty ((26/36)^12),
// so the deploy check would fail at random once *Password requirements* asks
// for digits. It must satisfy every character-class preset the dashboard
// offers, every time.
test("verify-auth's probe password satisfies every Supabase password preset, every time", async () => {
  const { probePassword } = await settingsModule();
  const classes: Array<[string, RegExp]> = [
    ["a lowercase letter", /[a-z]/],
    ["an uppercase letter", /[A-Z]/],
    ["a digit", /[0-9]/],
    ["a symbol", /[^A-Za-z0-9]/],
  ];
  for (let i = 0; i < 2000; i++) {
    const p = probePassword();
    assert.ok(p.length >= 12 && p.length <= 72, `length ${p.length}: ${p}`);
    for (const [name, re] of classes) assert.match(p, re, `${JSON.stringify(p)} lacks ${name}`);
  }
});
