// The attributes the session cookie is written with, EXECUTED: the real
// @supabase/ssr client through lib/supabase/server.ts (sign-in, in a Server
// Action) and through proxy.ts (token refresh, on every request), against
// ./_fake_gotrue.ts.
//
// ── THE DEFECT (F83) ─────────────────────────────────────────────────────────
//
// Neither createServerClient call set cookie options, so @supabase/ssr's
// defaults applied: no Secure attribute, and Max-Age 400 days. The cookie
// carries the refresh token, which does not expire by itself. So a plain-HTTP
// request to the domain (typed without https, before HSTS is cached) sent the
// whole session in cleartext, and a teacher who closed the browser on a shared
// school computer without signing out left the next person signed in as her
// for up to 400 days. Observed live: `Max-Age=34560000; SameSite=lax`, no
// Secure, behind x-forwarded-proto: https.
//
// NOTE @supabase/ssr 0.12 re-applies its 400-day Max-Age AFTER any
// cookieOptions the caller passes, so passing maxAge there is not enough; the
// bound has to be applied where the cookie is written.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, resetRequest, closeAppDb, webRequire } from "./_auth-harness.ts";
import { needsDatabase } from "./_harness.js";
import { fakeGoTrue, type FakeGoTrue } from "./_fake_gotrue.ts";

// Sign-in is throttled by a Postgres counter.
const skip = needsDatabase();

const TWELVE_HOURS = 12 * 60 * 60;
const authModule = () => import("../../apps/web/src/auth.ts");
const proxyModule = () => import("../../apps/web/src/proxy.ts");

let fake: FakeGoTrue;
let restoreEnv: () => void;
const savedAppUrl = process.env.APP_URL;
const IP = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

before(async () => {
  if (skip) return;
  fake = await fakeGoTrue();
  restoreEnv = fake.install();
});

after(async () => {
  if (skip) return;
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
  restoreEnv();
  await fake.close();
  await closeAppDb();
});

function setAppUrl(v: string | undefined) {
  if (v === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = v;
}

/** Sign in through the app and return the session-cookie writes. */
async function signInWrites(headers: Record<string, string> = {}) {
  const password = `pw-${randomUUID()}`;
  const u = fake.addUser({ email: `cookie-${randomUUID()}@example.test`, password });
  resetRequest({ "x-real-ip": IP, ...headers });
  const { signInWithPassword } = await authModule();
  assert.equal((await signInWithPassword(u.email, password)).error, null);
  const writes = request.cookieWrites.filter((w) => /^sb-.*-auth-token/.test(w.name) && w.value !== "");
  assert.ok(writes.length > 0, "sign-in must write the session cookie");
  return writes;
}

test("behind https, the session cookie is Secure and lives at most twelve hours", { skip }, async () => {
  setAppUrl("https://lms.example.test");
  for (const w of await signInWrites()) {
    assert.equal(w.options.secure, true, `${w.name} must be Secure on an https deployment`);
    assert.ok(
      typeof w.options.maxAge === "number" && w.options.maxAge > 0 && w.options.maxAge <= TWELVE_HOURS,
      `${w.name} Max-Age must be bounded for shared computers, got ${String(w.options.maxAge)}`,
    );
    assert.equal(w.options.sameSite, "lax");
  }
});

test("with no APP_URL, the forwarded protocol decides; plain-http local development still works", { skip }, async () => {
  setAppUrl(undefined);
  for (const w of await signInWrites({ "x-forwarded-proto": "https" })) assert.equal(w.options.secure, true);
  for (const w of await signInWrites()) {
    assert.notEqual(w.options.secure, true, "a Secure cookie over plain http would never be sent back");
  }
});

test("the proxy's token refresh writes the same bounded, Secure cookie", { skip }, async () => {
  setAppUrl("https://lms.example.test");
  // A short-lived access token, so the proxy's getClaims() refreshes it.
  fake.setAccessTokenTtl(30);
  try {
    await signInWrites();
    const cookieHeader = Object.entries(request.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const { NextRequest } = webRequire("next/server") as typeof import("next/server");
    const { default: proxy } = await proxyModule();
    const refreshesBefore = fake.calls("POST", "/token").filter((c) => c.query.get("grant_type") === "refresh_token").length;
    const res = await proxy(
      new NextRequest("http://0.0.0.0:3000/dashboard", { headers: { cookie: cookieHeader, "x-forwarded-proto": "https" } }),
    );
    const refreshed = fake.calls("POST", "/token").filter((c) => c.query.get("grant_type") === "refresh_token").length;
    assert.ok(refreshed > refreshesBefore, "the proxy must have refreshed the session");
    const setCookies = res.headers.getSetCookie().filter((c) => /^sb-.*-auth-token/.test(c) && !/Max-Age=0/i.test(c));
    assert.ok(setCookies.length > 0, "the rotated session must be written to the response");
    for (const c of setCookies) {
      assert.match(c, /;\s*Secure/i, `refreshed cookie must be Secure: ${c.slice(0, 40)}…`);
      const maxAge = Number(/Max-Age=(\d+)/i.exec(c)?.[1]);
      assert.ok(maxAge > 0 && maxAge <= TWELVE_HOURS, `refreshed cookie Max-Age must be bounded, got ${maxAge}`);
    }
  } finally {
    fake.setAccessTokenTtl(900);
  }
});
