// Password sign-in, EXECUTED: the real loginAction and signInWithPassword, the
// real @supabase/ssr client, the real Postgres rate limiter, against
// ./_fake_gotrue.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { resetRequest, outcome, form, closeAppDb } from "./_auth-harness.ts";
import { needsDatabase, DATABASE_URL } from "./_harness.js";
import { fakeGoTrue, type FakeGoTrue } from "./_fake_gotrue.ts";

const skip = needsDatabase();

const loginActions = () => import("../../apps/web/src/app/login/actions.ts");

let pg: Client;
let fake: FakeGoTrue;
let restoreEnv: () => void;
/** Accounts the access-token hook refuses (inactive profile, password right). */
const hookRefuses = new Set<string>();

before(async () => {
  if (skip) return;
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  fake = await fakeGoTrue({
    hook: (id) =>
      hookRefuses.has(id)
        ? { error: { http_code: 403, message: "This account is not active. Contact your administrator." } }
        : { role: "teacher" },
  });
  restoreEnv = fake.install();
});

after(async () => {
  if (skip) return;
  restoreEnv();
  await fake.close();
  await pg.end();
  await closeAppDb();
});

/** A client address no earlier run of this file has used. */
function freshIp(): string {
  const b = () => Math.floor(Math.random() * 250) + 1;
  return `100.${64 + Math.floor(Math.random() * 60)}.${b()}.${b()}`;
}

function makeUser() {
  const password = `pw-${randomUUID()}`;
  return { ...fake.addUser({ email: `signin-${randomUUID()}@example.test`, password }), password };
}

/** Submit the login form from a fresh browser at `ip`. */
async function submitLogin(ip: string, email: string, password: string) {
  resetRequest({ "x-real-ip": ip });
  const { loginAction } = await loginActions();
  return outcome(() => loginAction(undefined, form({ email, password, from: "" })));
}

const passwordGrants = () => fake.calls("POST", "/token").filter((c) => c.query.get("grant_type") === "password").length;

// ── F79: there was no application-level throttle ─────────────────────────────
//
// loginAction called signInWithPassword with no rateLimit() at all, and the
// comment in auth.ts said Supabase rate-limits sign-in centrally. It does, per
// client IP -- but every GoTrue call is made by the app server, so GoTrue sees
// ONE client for the whole deployment. Locally that meant unlimited online
// guessing (the audit posted 35 wrong passwords, all evaluated); hosted, it
// means one shared bucket that a single attacker can exhaust for everyone.

test("F79: guesses at one account from one address stop being evaluated after the limit", { skip }, async () => {
  const u = makeUser();
  const ip = freshIp();
  for (let i = 0; i < 10; i++) {
    const r = await submitLogin(ip, u.email, `wrong-${i}`);
    assert.equal(r.kind, "returned");
  }
  const evaluated = passwordGrants();
  const blocked = await submitLogin(ip, u.email, u.password);
  assert.equal(blocked.kind, "returned", "the 11th attempt must be refused, even with the right password");
  assert.equal((blocked as { value: { error?: string } }).value.error, "rate_limited");
  assert.equal(passwordGrants(), evaluated, "a throttled attempt must never reach GoTrue");

  // Somebody else, somewhere else, is not locked out by it: the limit is not a
  // switch a stranger can flip on another person's account.
  const elsewhere = await submitLogin(freshIp(), u.email, u.password);
  assert.equal(elsewhere.kind, "redirect", "the account holder signs in from their own address");
});

test("F79: one address spraying many accounts is throttled too", { skip }, async () => {
  const ip = freshIp();
  let refusedAt = -1;
  for (let i = 0; i < 120; i++) {
    const r = await submitLogin(ip, `spray-${randomUUID()}@example.test`, "guess");
    const err = String((r as { value?: { error?: string } }).value?.error ?? "");
    if (err === "rate_limited") {
      refusedAt = i;
      break;
    }
  }
  assert.ok(refusedAt > 0, "the per-address limit must stop a spray across accounts");
  assert.ok(refusedAt >= 60, `the per-address limit must leave room for a room of teachers behind one school NAT (refused at ${refusedAt})`);
});

test("F79: when the limiter itself is down, sign-in fails closed", { skip }, async () => {
  const u = makeUser();
  const evaluated = passwordGrants();
  await pg.query("ALTER TABLE rate_limits RENAME TO rate_limits_unavailable");
  let r;
  try {
    r = await submitLogin(freshIp(), u.email, u.password);
  } finally {
    await pg.query("ALTER TABLE rate_limits_unavailable RENAME TO rate_limits");
  }
  assert.equal(r.kind, "returned", "no session may be established while the limiter cannot count");
  assert.equal((r as { value: { error?: string } }).value.error, "unavailable");
  assert.equal(passwordGrants(), evaluated);
});

// ── F87: every failure but one read "Incorrect email or password." ──────────
//
// signInWithPassword mapped only 403 and 429, so a GoTrue or network outage, an
// unconfirmed address and a deactivated (banned) account all told the user
// their password was wrong -- and sent them to reset a password that was fine.
//
// The banned case has a constraint the others do not: GoTrue checks the ban
// BEFORE it checks the password (ResourceOwnerPasswordGrant: IsBanned, then
// Authenticate), so "user_banned" comes back for ANY password. A distinct
// message for it would tell a stranger which addresses are deactivated staff
// accounts. So it shares the wrong-credentials answer -- and that one answer
// now says what to do when you are sure the password is right.

const englishLogin = async () =>
  (await import("../../apps/web/src/i18n/config.ts")).loadMessages("en").login as unknown as {
    error: Record<string, string>;
  };

async function loginError(ip: string, email: string, password: string): Promise<unknown> {
  const r = await submitLogin(ip, email, password);
  assert.equal(r.kind, "returned", `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { value: { error?: unknown } }).value.error;
}

test("F87: a sign-in service outage is reported as an outage, not a wrong password", { skip }, async () => {
  const u = makeUser();
  fake.setOutage(503);
  try {
    assert.equal(await loginError(freshIp(), u.email, u.password), "unavailable");
  } finally {
    fake.setOutage(null);
  }
});

test("F87: an unreachable sign-in service is reported as an outage", { skip }, async () => {
  const u = makeUser();
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9"; // nothing listens on discard
  try {
    assert.equal(await loginError(freshIp(), u.email, u.password), "unavailable");
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
  }
});

test("F87: an unconfirmed address is told so, once the password is right", { skip }, async () => {
  const password = `pw-${randomUUID()}`;
  const u = fake.addUser({ email: `unconfirmed-${randomUUID()}@example.test`, password, emailConfirmed: false });
  assert.equal(await loginError(freshIp(), u.email, password), "email_not_confirmed");
});

test("F87: a deactivated account gets the shared answer, and it says to contact the administrator", { skip }, async () => {
  const u = makeUser();
  fake.users.get(u.id)!.bannedUntil = "2126-01-01T00:00:00Z";
  const banned = await loginError(freshIp(), u.email, u.password);
  const bannedWrong = await loginError(freshIp(), u.email, "not-it");
  const nobody = await loginError(freshIp(), `nobody-${randomUUID()}@example.test`, "whatever");
  assert.equal(banned, "invalid_credentials");
  assert.equal(bannedWrong, banned, "GoTrue reports the ban before checking the password: no distinct answer");
  assert.equal(nobody, banned, "an unknown address must be indistinguishable");
  assert.match((await englishLogin()).error.invalid_credentials, /administrator/i);
});

test("F87: an account the access-token hook refuses (password right, profile inactive) is told it is not active", { skip }, async () => {
  const u = makeUser();
  hookRefuses.add(u.id);
  assert.equal(await loginError(freshIp(), u.email, u.password), "inactive");
});

test("F87: an empty form is refused before anything is sent", { skip }, async () => {
  const before = passwordGrants();
  assert.equal(await loginError(freshIp(), "", ""), "missing_fields");
  assert.equal(passwordGrants(), before);
});
