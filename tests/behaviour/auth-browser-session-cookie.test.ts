// The session cookie the BROWSER client writes, EXECUTED: the real
// lib/supabase/browser.ts and the real @supabase/ssr createBrowserClient, in a
// stand-in browser (window, document.cookie, location), against
// ./_fake_gotrue.ts.
//
// ── THE DEFECT (F83, the third writer) ───────────────────────────────────────
//
// The session cookie is written in three places. The server client
// (lib/supabase/server.ts) and the proxy's refresh were fixed to write it
// Secure and with a Max-Age of at most twelve hours. The browser client was
// not: createBrowserClient(url, key) with no cookie methods writes through
// document.cookie with @supabase/ssr's defaults, Max-Age 400 days and no
// Secure. In a browser it also refreshes the session itself -- and the upload
// path asks it for a token before every request of a resumable upload, which
// on a Ladakh link outlives a 15-minute access token many times over. Each of
// those refreshes rewrote the cookie the server had bounded, unbounded and
// non-Secure.
//
// Each test file runs in its own process, so the browser globals set here do
// not leak into the server-side tests.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
// The harness resolves the app's @/ imports; nothing server-side is loaded here.
import { webRequire } from "./_auth-harness.ts";
import { fakeGoTrue, ANON_KEY, type FakeGoTrue } from "./_fake_gotrue.ts";

const TWELVE_HOURS = 12 * 60 * 60;

// ── a stand-in browser ────────────────────────────────────────────────────────

type Write = { raw: string; name: string; value: string; attrs: Record<string, string | true> };
const jar = new Map<string, string>();
const writes: Write[] = [];
const location = { protocol: "https:", href: "https://lms.example.test/uploads", origin: "https://lms.example.test" };

/** document.cookie: a getter over the jar, and a setter that records attributes as a browser would parse them. */
const documentStub = {
  get cookie(): string {
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  },
  set cookie(raw: string) {
    const [pair, ...rest] = raw.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    const attrs: Record<string, string | true> = {};
    for (const a of rest) {
      const i = a.indexOf("=");
      if (i < 0) attrs[a.trim().toLowerCase()] = true;
      else attrs[a.slice(0, i).trim().toLowerCase()] = a.slice(i + 1).trim();
    }
    writes.push({ raw, name, value, attrs });
    if (value === "" || attrs["max-age"] === "0") jar.delete(name);
    else jar.set(name, value);
  },
  visibilityState: "visible",
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const g = globalThis as Record<string, unknown>;
g.document = documentStub;
g.window = { document: documentStub, location, addEventListener: () => undefined, removeEventListener: () => undefined };
g.location = location;

const browserModule = () => import("../../apps/web/src/lib/supabase/browser.ts");
const ssr = webRequire("@supabase/ssr") as {
  createChunks: (key: string, value: string) => Array<{ name: string; value: string }>;
  stringToBase64URL: (s: string) => string;
};

let fake: FakeGoTrue;

before(async () => {
  fake = await fakeGoTrue();
});

after(async () => {
  const { supabaseBrowser } = await browserModule();
  await supabaseBrowser({ url: fake.url, anonKey: ANON_KEY }).auth.dispose();
  await fake.close();
});

/**
 * A browser holding a session cookie, as the server writes it at sign-in:
 * the session JSON, base64url-encoded with @supabase/ssr's prefix, in chunks
 * named after auth-js's storage key. The access token lives 30 s -- inside
 * auth-js's refresh margin -- so the browser's next getSession() refreshes.
 */
async function browserHoldingASession(): Promise<void> {
  const password = `pw-${randomUUID()}`;
  const u = fake.addUser({ email: `browser-${randomUUID()}@example.test`, password });
  fake.setAccessTokenTtl(30);
  const signedIn = await fake.deviceSignIn(u.email, password);
  assert.equal(signedIn.status, 200);
  const key = `sb-${new URL(fake.url).hostname.split(".")[0]}-auth-token`;
  jar.clear();
  for (const c of ssr.createChunks(key, "base64-" + ssr.stringToBase64URL(JSON.stringify(signedIn.body)))) {
    jar.set(c.name, c.value);
  }
  writes.length = 0;
}

/** What the upload path does before each tus request: ask for a token. Returns the session-cookie writes it caused. */
async function uploadAsksForAToken(): Promise<Write[]> {
  const refreshes = () => fake.calls("POST", "/token").filter((c) => c.query.get("grant_type") === "refresh_token").length;
  const before = refreshes();
  const { accessToken } = await browserModule();
  const token = await accessToken({ url: fake.url, anonKey: ANON_KEY });
  assert.ok(token, "the browser client must produce a token");
  assert.ok(refreshes() > before, "the browser client must have refreshed the session");
  const out = writes.filter((w) => /^sb-.*-auth-token/.test(w.name) && w.value !== "" && w.attrs["max-age"] !== "0");
  assert.ok(out.length > 0, "the refreshed session must be written to document.cookie");
  return out;
}

test("the browser client's token refresh writes the session cookie Secure and at most twelve hours", async () => {
  location.protocol = "https:";
  try {
    await browserHoldingASession();
    for (const w of await uploadAsksForAToken()) {
      assert.equal(w.attrs.secure, true, `a refresh in the browser must write ${w.name} Secure: ${w.raw.slice(-80)}`);
      const maxAge = Number(w.attrs["max-age"]);
      assert.ok(
        maxAge > 0 && maxAge <= TWELVE_HOURS,
        `a refresh in the browser must not re-extend ${w.name} past twelve hours, got Max-Age=${String(w.attrs["max-age"])}`,
      );
      assert.equal(String(w.attrs.samesite).toLowerCase(), "lax");
    }
  } finally {
    fake.setAccessTokenTtl(900);
  }
});

test("on a plain-http page (local development) the browser writes it without Secure, still bounded", async () => {
  location.protocol = "http:";
  try {
    await browserHoldingASession();
    for (const w of await uploadAsksForAToken()) {
      assert.notEqual(w.attrs.secure, true, "a Secure cookie set from an http page would be refused by the browser");
      assert.ok(Number(w.attrs["max-age"]) <= TWELVE_HOURS);
    }
  } finally {
    location.protocol = "https:";
    fake.setAccessTokenTtl(900);
  }
});
