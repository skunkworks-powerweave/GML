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

before(async () => {
  if (skip) return;
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  fake = await fakeGoTrue();
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
  assert.match(String((blocked as { value: { error?: string } }).value.error), /too many/i);
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
    if (/too many/i.test(err)) {
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
  assert.match(String((r as { value: { error?: string } }).value.error), /unavailable/i);
  assert.equal(passwordGrants(), evaluated);
});
