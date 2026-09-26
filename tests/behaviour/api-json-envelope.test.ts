// A malformed request is told it is malformed, in the same words everywhere.
//
// ── F100 (user-prefs, helpdesk, system-settings, audit/resource-view) ────────
//
// These routes read their body with `req.json().catch(() => ({}))` (or, in
// helpdesk, JSON.parse inside a catch that fell back to {}), so a body that
// was not JSON at all became an EMPTY body and carried on:
//
//   PUT  /api/user-prefs            '{bad' -> 200 {"ok":true}, upserted and
//                                   audited as a successful update
//   POST /api/helpdesk/tickets      '{bad' -> a help request in every
//                                   administrator's inbox
//   PUT  /api/admin/system-settings '{bad' -> 400 "empty_patch", which says the
//                                   caller sent nothing
//   POST /api/audit/resource-view   '{bad' -> 400 "validation_failed"
//
// Their 400s returned zod's issues verbatim, and zod 3 puts the rejected value
// in both `received` and the message: a 2 MB `density` came back twice in the
// response. And the 401 token was "unauthorized" on two of them and
// "unauthenticated" on the rest (and in lib/api-guards).
//
// Executed: the real route handlers, as real users, against Postgres.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, request, type Fixture } from "./_admin-fixture.js";
import { closeAppPool } from "./_mentorship.js";

const skip = needsDatabase();
after(closeAppPool);

const userPrefs = () => import("../../apps/web/src/app/api/user-prefs/route.ts");
const helpdesk = () => import("../../apps/web/src/app/api/helpdesk/tickets/route.ts");
const systemSettings = () => import("../../apps/web/src/app/api/admin/system-settings/route.ts");
const resourceView = () => import("../../apps/web/src/app/api/audit/resource-view/route.ts");
const quickfind = () => import("../../apps/web/src/app/api/quickfind/route.ts");

const send = (method: string, path: string, body?: string) =>
  new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });

type Envelope = { error?: string; issues?: Array<Record<string, unknown>>; ok?: boolean };

/** Status plus the parsed body -- and the raw length, which is what F100 bounds. */
async function read(res: Response): Promise<{ status: number; body: Envelope; length: number }> {
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Envelope) : {}, length: text.length };
}

/** Wait out the voided recordAudit() a route may have fired, then count this user's rows. */
async function auditCount(c: Client, userId: string, action: string): Promise<number> {
  await new Promise((r) => setTimeout(r, 400));
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log WHERE user_id = $1 AND action = $2`,
    [userId, action],
  );
  return Number(rows[0]!.n);
}

async function signedIn(f: Fixture, role: string): Promise<string> {
  const id = await f.user(role, role);
  f.defer(`DELETE FROM rate_limits WHERE key LIKE $1`, [`%:${id}`]);
  actAs(id, role);
  return id;
}

const MALFORMED = "{bad";

// ── malformed JSON ───────────────────────────────────────────────────────────

test("F100 readJsonBody: not-JSON and empty are 400 invalid_json, unless a route opts in to empty", async () => {
  const { readJsonBody } = await import("../../apps/web/src/lib/api-json.ts");
  const body = (text: string) => new Request("http://x/", { method: "POST", body: text });

  for (const text of [MALFORMED, "", "  \n", "{\"a\":1} trailing"]) {
    const r = await readJsonBody(body(text));
    assert.equal(r.response?.status, 400, JSON.stringify(text));
    assert.deepEqual(await r.response?.json(), { error: "invalid_json" });
  }
  assert.deepEqual(await readJsonBody(body("{\"a\":1}")), { body: { a: 1 } });
  // helpdesk opts in: a bare POST is a ticket with the defaults, as it was.
  assert.deepEqual(await readJsonBody(body(""), { allowEmpty: true }), { body: {} });
  assert.equal((await readJsonBody(body(MALFORMED), { allowEmpty: true })).response?.status, 400);
});

test("F100 user-prefs: a body that is not JSON is 400 invalid_json, and nothing is saved or audited", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prefs-bad"));
    try {
      const me = await signedIn(f, "teacher");
      const { PUT } = await userPrefs();
      const res = await read(await PUT(send("PUT", "/api/user-prefs", MALFORMED)));
      assert.deepEqual([res.status, res.body], [400, { error: "invalid_json" }], "a malformed PUT was reported as a success");
      const { rows } = await c.query(`SELECT 1 FROM user_prefs WHERE user_id = $1`, [me]);
      assert.equal(rows.length, 0, "a malformed PUT upserted the defaults");
      assert.equal(await auditCount(c, me, "user_prefs.update"), 0, "a malformed PUT was audited as an update");

      // A well-formed PUT is untouched by this.
      const ok = await read(await PUT(send("PUT", "/api/user-prefs", JSON.stringify({ density: "dense" }))));
      assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
      const saved = await c.query<{ density: string }>(`SELECT density FROM user_prefs WHERE user_id = $1`, [me]);
      assert.deepEqual(saved.rows, [{ density: "dense" }]);
      assert.equal(await auditCount(c, me, "user_prefs.update"), 1);
    } finally {
      await f.cleanup();
    }
  });
});

// W3-27: PrefsSchema makes every field optional and strips unknown keys, so
// `{}` -- or a body of keys it does not know -- parsed to an EMPTY patch that
// still upserted the row (a row of defaults, or a bumped updated_at), wrote a
// user_prefs.update row with `keys: []`, and answered 200 ok. Every call, with
// no throttle. system-settings answers the same request 400 empty_patch.
test("W3-27 user-prefs: a PUT that sets nothing is 400 empty_patch, and nothing is saved or audited", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prefs-empty"));
    try {
      const me = await signedIn(f, "teacher");
      const { PUT } = await userPrefs();
      for (const body of ["{}", JSON.stringify({ foo: 1, bar: "x" })]) {
        const res = await read(await PUT(send("PUT", "/api/user-prefs", body)));
        assert.deepEqual([res.status, res.body], [400, { error: "empty_patch" }], `${body} was answered as a successful update`);
      }
      const { rows } = await c.query(`SELECT 1 FROM user_prefs WHERE user_id = $1`, [me]);
      assert.equal(rows.length, 0, "a PUT that set nothing upserted the defaults");
      assert.equal(await auditCount(c, me, "user_prefs.update"), 0, "a PUT that set nothing was audited as an update");

      // A real change, and clearing the tour timestamp (one key, null), still work.
      for (const body of [{ density: "dense" }, { ftuxSeenAt: null }]) {
        const ok = await read(await PUT(send("PUT", "/api/user-prefs", JSON.stringify(body))));
        assert.deepEqual([ok.status, ok.body], [200, { ok: true }], JSON.stringify(body));
      }
      assert.equal(await auditCount(c, me, "user_prefs.update"), 2);
    } finally {
      await f.cleanup();
    }
  });
});

test("F100 helpdesk: a body that is not JSON opens no ticket", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("help-bad"));
    try {
      const admin = await f.user("programme_admin", "padmin");
      await signedIn(f, "teacher");
      const { POST } = await helpdesk();
      const res = await read(await POST(send("POST", "/api/helpdesk/tickets", MALFORMED)));
      assert.deepEqual([res.status, res.body], [400, { error: "invalid_json" }], "garbage was filed as a help request");
      const { rows } = await c.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'helpdesk.ticket'`, [admin]);
      assert.equal(rows.length, 0, "garbage reached an administrator's inbox");
    } finally {
      await f.cleanup();
    }
  });
});

test("F100 system-settings: a body that is not JSON is invalid_json, not an empty patch", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("sys-bad"));
    try {
      await signedIn(f, "super_admin");
      const { PUT } = await systemSettings();
      const res = await read(await PUT(send("PUT", "/api/admin/system-settings", MALFORMED)));
      assert.deepEqual([res.status, res.body], [400, { error: "invalid_json" }]);
    } finally {
      await f.cleanup();
    }
  });
});

test("F100 resource-view: a body that is not JSON is invalid_json, and a malformed id never reaches Postgres", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("rv-bad"));
    try {
      await signedIn(f, "teacher");
      const { POST } = await resourceView();
      const res = await read(await POST(send("POST", "/api/audit/resource-view", MALFORMED)));
      assert.deepEqual([res.status, res.body], [400, { error: "invalid_json" }]);

      // F30 for this route: the id is validated as a uuid before anything is
      // written, so a truncated link is a 400, not a 22P02 500.
      for (const id of ["not-a-uuid", randomUUID().slice(0, 30)]) {
        const bad = await read(await POST(send("POST", "/api/audit/resource-view", JSON.stringify({ id }))));
        assert.equal(bad.status, 400, id);
        assert.equal(bad.body.error, "validation_failed");
      }
    } finally {
      await f.cleanup();
    }
  });
});

// ── validation failures ──────────────────────────────────────────────────────

test("F100: a validation failure names the field without echoing what was sent", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("issues"));
    try {
      await signedIn(f, "super_admin");
      const huge = "x".repeat(200_000);

      const { PUT: putPrefs } = await userPrefs();
      const prefs = await read(await putPrefs(send("PUT", "/api/user-prefs", JSON.stringify({ density: huge }))));
      assert.equal(prefs.status, 400);
      assert.equal(prefs.body.error, "validation_failed");
      assert.ok(prefs.length < 2_000, `a 200 KB value came back in a ${prefs.length}-byte 400`);
      assert.deepEqual(prefs.body.issues?.map((i) => i.path), [["density"]], "the issue still names the field");
      for (const issue of prefs.body.issues ?? []) {
        assert.deepEqual(Object.keys(issue).sort(), ["message", "path"]);
      }

      // Thousands of bad array entries are thousands of issues.
      const { PUT: putSettings } = await systemSettings();
      const settings = await read(
        await putSettings(
          send("PUT", "/api/admin/system-settings", JSON.stringify({ notificationsEnabled: Array(5_000).fill("nope") })),
        ),
      );
      assert.equal(settings.status, 400);
      assert.equal(settings.body.error, "validation_failed");
      assert.ok(settings.length < 10_000, `5,000 rejected entries produced a ${settings.length}-byte 400`);
    } finally {
      await f.cleanup();
    }
  });
});

// ── one 401 token ────────────────────────────────────────────────────────────

test("F100: every one of these routes answers a signed-out caller with the same 401", { skip }, async () => {
  request.session = null;
  const [prefs, help, settings, rv, qf] = await Promise.all([userPrefs(), helpdesk(), systemSettings(), resourceView(), quickfind()]);
  const calls: Array<[string, () => Promise<Response>]> = [
    ["GET /api/user-prefs", () => prefs.GET()],
    ["PUT /api/user-prefs", () => prefs.PUT(send("PUT", "/api/user-prefs", "{}"))],
    ["POST /api/helpdesk/tickets", () => help.POST(send("POST", "/api/helpdesk/tickets", "{}"))],
    ["GET /api/admin/system-settings", () => settings.GET()],
    ["PUT /api/admin/system-settings", () => settings.PUT(send("PUT", "/api/admin/system-settings", "{}"))],
    ["POST /api/audit/resource-view", () => rv.POST(send("POST", "/api/audit/resource-view", "{}"))],
    ["GET /api/quickfind", () => qf.GET(new Request("http://x/api/quickfind?q=ab"))],
  ];
  for (const [name, call] of calls) {
    const res = await read(await call());
    assert.deepEqual([res.status, res.body], [401, { error: "unauthenticated" }], name);
  }
});
