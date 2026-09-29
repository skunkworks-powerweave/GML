// Deciding an account request: approving makes a login that works, exactly
// as /admin/users makes one; rejecting keeps the reason; and the approval and
// the login never disagree.
//
// Executed: the real decideAction (/approvals) and lib/approvals, as a signed-in
// programme admin, against Postgres with the app's own pool, and the app's
// REAL Supabase admin client talking to ./_fake_gotrue.ts -- the stand-in for
// Supabase Auth -- so the login that is created can then be signed in with,
// over HTTP, with the initial password the approver was shown.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { React, h, render, renderSync, request } from "./_ui.js";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { fixture, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, form, signIn } from "./_server-actions.js";
import { fakeGoTrue, withRowFault, type FakeGoTrue } from "./_fake_gotrue.ts";

const skip = needsDatabase();
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));

let pg: Client;
let fake: FakeGoTrue;
let restoreEnv: () => void;

before(async () => {
  if (skip) return;
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  fake = await fakeGoTrue({
    // The access-token hook: the profile decides, as in the app.
    hook: async (id) => {
      const { rows } = await pg.query<{ role: string; active: boolean }>("SELECT role, active FROM users WHERE id = $1", [id]);
      if (!rows[0]?.active) return { error: { http_code: 403, message: "not active" } };
      return { role: rows[0].role };
    },
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

const decide = async (approvalId: string, decision: string, comment = "") => {
  const { decideAction } = await import("../../apps/web/src/app/(authenticated)/approvals/actions.ts");
  return decideAction(undefined, form({ approvalId, decision, comment }));
};
const as = (id: string, role: string) => signIn({ id, role });
const fakeUser = (email: string) => [...fake.users.values()].find((u) => u.email === email.toLowerCase());
const createCalls = () => fake.calls("POST", "/admin/users").length;

type World = { f: Fixture; t: string; school: string; padmin: string; requestId: string; approvalId: string; email: string };

/** A school and a pending account request for a teacher there, as the public form leaves it. */
async function world(f: Fixture, t: string, opts: { email?: string; role?: string; school?: boolean } = {}): Promise<World> {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: `S${code}`.slice(0, 16) });
  const padmin = await f.user("programme_admin", `pa-${code.toLowerCase()}`);
  const email = opts.email ?? `dolma.${t}@example.test`;
  // Whatever an approval makes for this address is removed again, children first.
  f.defer(`DELETE FROM users WHERE lower(email) = lower($1) AND id <> ALL($2::uuid[])`, [email, [padmin]]);
  f.defer(`DELETE FROM teachers WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower($1))`, [email]);
  const requestId = await f.row("account_requests", {
    full_name: `Tsering Dolma ${t}`,
    email,
    phone: "+919876543210",
    school_id: opts.school === false ? null : school,
    requested_role: opts.role ?? "teacher",
    message: `Grade 5 ${t}`,
  });
  const approvalId = await f.row("approvals", { item_type: "account_request", item_id: requestId, note: `Grade 5 ${t}` });
  f.defer(`DELETE FROM approvals WHERE item_id = $1`, [requestId]);
  return { f, t, school, padmin, requestId, approvalId, email };
}

const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
/** The row's metadata keys are exactly the ones docs/audit-actions.md lists for its action. */
function documented(action: string, metadata: Record<string, unknown>): void {
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${action}\` |`));
  assert.ok(line, `${action} is not documented in docs/audit-actions.md`);
  const keys = new Set([...line.split("|")[3]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]));
  assert.deepEqual(new Set(Object.keys(metadata)), keys, `${action}: the metadata written and the metadata documented differ`);
}

/** Render with `state` as the form's action state, as React passes it once the action settled. */
function withActionState<T>(state: unknown, body: () => T): T {
  const r = React as unknown as { useActionState: (a: unknown, i: unknown, p?: string) => unknown };
  const real = r.useActionState;
  r.useActionState = (action, _initial, permalink) => real(action, state, permalink);
  try {
    return body();
  } finally {
    r.useActionState = real;
  }
}

const requestRow = async (c: Client, id: string) => (await c.query(`SELECT * FROM account_requests WHERE id = $1`, [id])).rows[0];
const approvalRow = async (c: Client, id: string) => (await c.query(`SELECT * FROM approvals WHERE id = $1`, [id])).rows[0];

test("approving a teacher's request creates a login she can sign in with, linked to a teacher record at her school", { skip }, async () => {
  const f = fixture(pg, tag("aa"));
  try {
    const w = await world(f, tag("aaw"));
    as(w.padmin, "programme_admin");
    request.revalidated = [];
    const r = await decide(w.approvalId, "approved");
    assert.equal(r.decided, "approved", JSON.stringify(r));
    assert.equal(r.email, w.email);
    assert.match(r.ok ?? "", new RegExp(`A login was created for ${w.email.replace(/\./g, "\\.")}`));
    assert.match(r.password ?? "", /^[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}$/, "a generated password");
    assert.deepEqual(request.revalidated, [], "the page is not refreshed under the approver: the password stays on screen");
    // What the decision form shows with that answer (React hands useActionState
    // exactly this value once the action settles): the password, once, to pass on.
    const { DecisionForm } = await import("../../apps/web/src/app/(authenticated)/approvals/decision-form.tsx");
    const panel = withActionState(r, () => renderSync(h(DecisionForm as never, { approvalId: w.approvalId, decisions: ["approved", "rejected"] })));
    assert.match(panel, new RegExp(`data-testid="initial-password"[^>]*>${r.password}</output>`));
    assert.match(panel, new RegExp(`Initial password for ${w.email.replace(/\./g, "\\.")}`));
    assert.match(panel, /shown only this once and is not stored anywhere/);
    assert.doesNotMatch(panel, /name="decision"/, "and nothing more to decide");

    // The login, made as /admin/users makes one.
    const login = fakeUser(w.email);
    assert.ok(login, "a Supabase Auth login exists");
    assert.equal(login.emailConfirmed, true, "the address is confirmed: no email is coming");
    assert.equal(login.appMetadata.must_change_password, true, "she must choose her own password");
    assert.equal(login.userMetadata.name, `Tsering Dolma ${w.t}`);
    const { rows: [profile] } = await pg.query(`SELECT role, active, name, email FROM users WHERE id = $1`, [login.id]);
    assert.deepEqual(profile, { role: "teacher", active: true, name: `Tsering Dolma ${w.t}`, email: w.email });
    const { rows: teacherRows } = await pg.query(`SELECT school_id, full_name, phone, active FROM teachers WHERE user_id = $1`, [login.id]);
    assert.deepEqual(teacherRows, [{ school_id: w.school, full_name: `Tsering Dolma ${w.t}`, phone: "+919876543210", active: true }]);

    // The request and the queue say the same thing.
    const req = await requestRow(pg, w.requestId);
    assert.equal(req.status, "approved");
    assert.equal(req.decided_by_user_id, w.padmin);
    assert.ok(req.decided_at);
    assert.equal(req.created_user_id, login.id);
    const appr = await approvalRow(pg, w.approvalId);
    assert.equal(appr.status, "approved");
    assert.equal(appr.decided_by_user_id, w.padmin);

    // Usable: she signs in with what the approver was shown, as a teacher.
    const signedIn = await fake.deviceSignIn(w.email, r.password!);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const claims = JSON.parse(Buffer.from(String(signedIn.body.access_token).split(".")[1]!, "base64url").toString());
    assert.equal(claims.user_role, "teacher");
    assert.equal(claims.app_metadata.must_change_password, true, "and is sent to choose her own password");

    // Audited, and the password is nowhere but the approver's screen.
    const { rows: audit } = await pg.query(
      `SELECT user_id, metadata FROM audit_log WHERE action = 'account_request.approved' AND entity_id = $1`,
      [w.requestId],
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].user_id, w.padmin);
    assert.deepEqual(audit[0].metadata, { approvalId: w.approvalId, role: "teacher", createdUserId: login.id });
    documented("account_request.approved", audit[0].metadata);
    const leaks = await pg.query(
      `SELECT (SELECT count(*) FROM audit_log WHERE metadata::text LIKE $1)::int AS audit,
              (SELECT count(*) FROM notifications WHERE subject LIKE $1 OR body LIKE $1)::int AS inbox,
              (SELECT count(*) FROM account_requests WHERE id = $2 AND row_to_json(account_requests)::text LIKE $1)::int AS request`,
      [`%${r.password}%`, w.requestId],
    );
    assert.deepEqual(leaks.rows[0], { audit: 0, inbox: 0, request: 0 }, "the initial password is never stored");

    // Once decided, never again.
    assert.match((await decide(w.approvalId, "approved")).error ?? "", /already been decided/);
    assert.match((await decide(w.approvalId, "rejected", "late")).error ?? "", /already been decided/);

    // The request page shows it was approved and a login made, with no form.
    const { default: RequestPage } = await import("../../apps/web/src/app/(authenticated)/approvals/[id]/page.tsx");
    const html = await render(await RequestPage({ params: Promise.resolve({ id: w.approvalId }) }));
    assert.match(html, /the login was created/);
    assert.doesNotMatch(html, /name="decision"/);
  } finally {
    signIn(null);
    await f.cleanup();
  }
});

test("a mentor's request makes a mentor login and no teacher record", { skip }, async () => {
  const f = fixture(pg, tag("am"));
  try {
    const w = await world(f, tag("amw"), { role: "mentor", school: false });
    as(w.padmin, "super_admin");
    const r = await decide(w.approvalId, "approved");
    assert.equal(r.decided, "approved", JSON.stringify(r));
    const login = fakeUser(w.email)!;
    const { rows: [profile] } = await pg.query(`SELECT role FROM users WHERE id = $1`, [login.id]);
    assert.equal(profile.role, "mentor");
    assert.equal((await pg.query(`SELECT 1 FROM teachers WHERE user_id = $1`, [login.id])).rowCount, 0);
    assert.equal((await fake.deviceSignIn(w.email, r.password!)).status, 200);
  } finally {
    signIn(null);
    await f.cleanup();
  }
});

test("an address that already has a login is refused with a clear message, and nothing is created", { skip }, async () => {
  const f = fixture(pg, tag("ae"));
  try {
    const t = tag("aew");
    // Someone made this login at /admin/users after the request came in.
    const existingEmail = `taken.${t}@example.test`;
    await f.row("users", { id: randomUUID(), email: existingEmail, name: "Taken", role: "teacher" });
    const w = await world(f, t, { email: existingEmail.toUpperCase() });

    // The approver is warned before deciding, in Hindi too.
    as(w.padmin, "programme_admin");
    request.locale = "hi";
    const { default: RequestPage } = await import("../../apps/web/src/app/(authenticated)/approvals/[id]/page.tsx");
    const html = await render(await RequestPage({ params: Promise.resolve({ id: w.approvalId }) }));
    assert.match(html, /data-testid="email-has-login"[^>]*>इस ईमेल पते का खाता पहले से है/);
    request.locale = "en";

    const before = createCalls();
    const r = await decide(w.approvalId, "approved");
    assert.match(r.error ?? "", /already has a login, so no new one was made/);
    assert.equal(r.password, undefined);
    assert.equal(createCalls(), before, "Supabase Auth was not asked for a login");
    assert.equal((await requestRow(pg, w.requestId)).status, "pending");
    assert.equal((await approvalRow(pg, w.approvalId)).status, "pending");
    assert.equal((await pg.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [existingEmail])).rowCount, 1);

    // A login Supabase Auth has but the profile table does not yet: refused the same way.
    const w2 = await world(f, tag("aew2"));
    fake.addUser({ email: w2.email, password: "someone-elses-1" });
    const r2 = await decide(w2.approvalId, "approved");
    assert.match(r2.error ?? "", /already has a login/);
    assert.equal((await requestRow(pg, w2.requestId)).created_user_id, null);
    assert.equal((await approvalRow(pg, w2.approvalId)).status, "pending");
    fake.users.delete(fakeUser(w2.email)!.id);
  } finally {
    request.locale = "en";
    signIn(null);
    await f.cleanup();
  }
});

test("rejecting needs a reason, keeps it, and creates nothing", { skip }, async () => {
  const f = fixture(pg, tag("ar"));
  try {
    const w = await world(f, tag("arw"));
    as(w.padmin, "programme_admin");
    const before = createCalls();
    assert.match((await decide(w.approvalId, "rejected", "  ")).error ?? "", /Write a comment/);
    assert.equal((await requestRow(pg, w.requestId)).status, "pending");
    assert.match((await decide(w.approvalId, "changes_requested", "Use your school address")).error ?? "", /nothing to send back/);

    const r = await decide(w.approvalId, "rejected", `Not on the programme's list ${w.t}`);
    assert.equal(r.decided, "rejected", JSON.stringify(r));
    const req = await requestRow(pg, w.requestId);
    assert.equal(req.status, "rejected");
    assert.equal(req.decision_reason, `Not on the programme's list ${w.t}`);
    assert.equal(req.decided_by_user_id, w.padmin);
    assert.equal(req.created_user_id, null);
    const appr = await approvalRow(pg, w.approvalId);
    assert.equal(appr.status, "rejected");
    assert.equal(appr.comment, `Not on the programme's list ${w.t}`);
    assert.equal(createCalls(), before, "no login was asked for");
    const { rows: audit } = await pg.query(
      `SELECT user_id, metadata FROM audit_log WHERE action = 'account_request.rejected' AND entity_id = $1`,
      [w.requestId],
    );
    assert.deepEqual(audit, [{ user_id: w.padmin, metadata: { approvalId: w.approvalId } }]);
    documented("account_request.rejected", audit[0].metadata);
    assert.match((await decide(w.approvalId, "approved")).error ?? "", /already been decided/);
    assert.equal(fakeUser(w.email), undefined);
  } finally {
    signIn(null);
    await f.cleanup();
  }
});

test("only a programme admin or super admin decides one, and the check comes before any login is made", { skip }, async () => {
  const f = fixture(pg, tag("an"));
  try {
    const w = await world(f, tag("anw"));
    const before = createCalls();
    for (const role of ["teacher", "mentor", "observer"]) {
      as(await f.user(role, `${role}x`), role);
      assert.match((await decide(w.approvalId, "approved")).error ?? "", /cannot decide/, `a ${role} cannot approve`);
      assert.match((await decide(w.approvalId, "rejected", "no")).error ?? "", /cannot decide/, `a ${role} cannot reject`);
    }
    signIn(null);
    assert.match((await decide(w.approvalId, "approved")).error ?? "", /Sign in again/);
    assert.equal(createCalls(), before, "no login was asked for");
    assert.equal((await requestRow(pg, w.requestId)).status, "pending");
    const { approveAccountRequest } = await import("../../apps/web/src/lib/approvals/account-requests.ts");
    const { db } = webRequire("@gml/db") as { db: never };
    assert.deepEqual(
      await approveAccountRequest(db, { approvalId: w.approvalId, actor: { id: w.padmin, role: "observer" } }),
      { ok: false, error: "not_allowed" },
    );
  } finally {
    signIn(null);
    await f.cleanup();
  }
});

test("the approval and the login cannot disagree: nothing half-made survives a failure", { skip }, async () => {
  const f = fixture(pg, tag("ax"));
  try {
    const w = await world(f, tag("axw"));
    const lib = await import("../../apps/web/src/lib/approvals/index.ts");
    const { AccountRequestStateError } = await import("../../apps/web/src/lib/approvals/handlers/account-request.ts");
    const { rejectAccountRequest } = await import("../../apps/web/src/lib/approvals/account-requests.ts");
    const { db } = webRequire("@gml/db") as { db: never };
    const admin = { id: w.padmin, role: "programme_admin" };

    // Deciding "approved" in the queue alone, with no login behind it, is refused
    // inside the decision's own transaction: the queue does not move.
    await assert.rejects(lib.decideApproval(db, { approvalId: w.approvalId, decision: "approved", actor: admin }), AccountRequestStateError);
    assert.equal((await approvalRow(pg, w.approvalId)).status, "pending");
    assert.equal((await requestRow(pg, w.requestId)).status, "pending");

    as(w.padmin, "programme_admin");
    // Supabase Auth refuses: nothing is made, the request still waits.
    fake.setFault((s) => (s.method === "POST" && s.path === "/admin/users" ? { status: 500, code: "unexpected_failure", message: "down" } : null));
    const down = await decide(w.approvalId, "approved");
    fake.setFault(null);
    assert.match(down.error ?? "", /could not be created .*Nothing was created/);
    assert.equal(fakeUser(w.email), undefined);
    assert.equal((await approvalRow(pg, w.approvalId)).status, "pending");

    // The teacher record cannot be written: the login Supabase already made is
    // removed again, with its profile, and the request still waits.
    const refused = await withRowFault(pg, "teachers", "INSERT", `NEW.school_id = '${w.school}'`, () => decide(w.approvalId, "approved"));
    assert.match(refused.error ?? "", /Nothing was created/, JSON.stringify(refused));
    assert.equal(refused.password, undefined);
    assert.equal(fakeUser(w.email), undefined, "the Supabase login was deleted");
    assert.equal((await pg.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [w.email])).rowCount, 0, "and its profile");
    const req = await requestRow(pg, w.requestId);
    assert.deepEqual([req.status, req.created_user_id], ["pending", null]);
    assert.equal((await approvalRow(pg, w.approvalId)).status, "pending");

    // While an approval is creating the login (the request is claimed), a
    // rejection cannot land underneath it.
    await pg.query(`UPDATE account_requests SET created_user_id = $1 WHERE id = $2`, [w.padmin, w.requestId]);
    assert.deepEqual(await rejectAccountRequest(db, { approvalId: w.approvalId, actor: admin, comment: "no" }), {
      ok: false,
      error: "not_pending",
    });
    assert.equal((await approvalRow(pg, w.approvalId)).status, "pending");
    await pg.query(`UPDATE account_requests SET created_user_id = NULL WHERE id = $1`, [w.requestId]);

    // And after all that, it can still be approved cleanly.
    const ok = await decide(w.approvalId, "approved");
    assert.equal(ok.decided, "approved", JSON.stringify(ok));
    assert.equal((await fake.deviceSignIn(w.email, ok.password!)).status, 200);
  } finally {
    fake.setFault(null);
    signIn(null);
    await f.cleanup();
  }
});

test("the proxy lets anyone reach /request-account and sends the signed-out from /approvals to sign in", { skip }, async () => {
  const { NextRequest } = webRequire("next/server") as typeof import("next/server");
  const { default: proxy } = await import("../../apps/web/src/proxy.ts");
  const open = await proxy(new NextRequest("http://0.0.0.0:3000/request-account"));
  assert.equal(open.headers.get("location"), null, "the request form is public");
  const queue = await proxy(new NextRequest("http://0.0.0.0:3000/approvals?status=rejected"));
  const to = new URL(queue.headers.get("location") ?? "http://x/");
  assert.equal(to.pathname, "/login");
  assert.equal(to.searchParams.get("from"), "/approvals?status=rejected");
});
