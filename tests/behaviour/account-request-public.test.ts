// "Request an account": the public form linked from both login screens.
//
// Executed: the real requestAccountAction (nobody signed in), against
// Postgres, with the app's own pool, and the real page rendered. What it must
// do: record the request and its pending approval together, tell the
// programme admins, audit it with no actor -- and answer every request with
// the same neutral confirmation, whether it was recorded, the address already
// had one waiting, or a bot filled in the honeypot. Requests are throttled
// per network address.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { h, render, renderSync, request, withAppRouter } from "./_ui.js";
import { phoneLayoutIssues } from "./_phone-layout.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, form, signIn } from "./_server-actions.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
const action = async () => (await import("../../apps/web/src/app/request-account/actions.ts")).requestAccountAction;

/** A fresh documentation-range address per test, so no other test's counter is shared. */
const freshIp = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

/**
 * Run `body` with the notifications it writes to anyone but `keep` dropped.
 * A request notifies every active programme admin in the database, and a
 * shared test database holds other files' administrators, whose own inbox
 * assertions would see these. `marker` must be a test-generated value.
 */
async function quietNotifications<T>(c: Client, marker: string, keep: string[], body: () => Promise<T>): Promise<T> {
  const name = `test_quiet_${randomUUID().replace(/-/g, "")}`;
  const kept = keep.length ? `ARRAY[${keep.map((id) => `'${id}'::uuid`).join(",")}]` : "ARRAY[]::uuid[]";
  await c.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN IF NEW.subject LIKE '%${marker}%' AND NOT (NEW.user_id = ANY(${kept})) THEN RETURN NULL; END IF; RETURN NEW; END $f$`,
  );
  await c.query(`CREATE TRIGGER ${name} BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  try {
    return await body();
  } finally {
    await c.query(`DROP TRIGGER IF EXISTS ${name} ON notifications`);
    await c.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  }
}

async function world(f: Fixture, t: string) {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: `S${code}`.slice(0, 16) });
  const closed = await f.row("schools", { zone_id: zone, name: `Closed ${t}`, code: `C${code}`.slice(0, 16), active: false });
  const padmin = await f.user("programme_admin", "pa");
  // Everything a request from this test writes is keyed on `t` in the address.
  f.defer(`DELETE FROM account_requests WHERE email LIKE $1`, [`%${t}%`]);
  f.defer(`DELETE FROM approvals WHERE item_type = 'account_request' AND item_id IN (SELECT id FROM account_requests WHERE email LIKE $1)`, [`%${t}%`]);
  f.defer(`DELETE FROM notifications WHERE user_id = $1`, [padmin]);
  return { school, closed, padmin };
}

const requestsFor = (c: Client, email: string) =>
  c.query(`SELECT * FROM account_requests WHERE lower(email) = lower($1) ORDER BY created_at`, [email]);

test("a request is recorded with its pending approval, audited with no actor, and the programme admins are told", { skip }, async () => {
  const requestAccountAction = await action();
  await withClient(async (c) => {
    const t = tag("arq");
    const f = fixture(c, t);
    const ip = freshIp();
    f.defer(`DELETE FROM rate_limits WHERE key = $1`, [`account-request:address:${ip}`]);
    try {
      const w = await world(f, t);
      signIn(null);
      request.headers = { "x-real-ip": ip };
      const email = `Dolma.${t}@Example.test`;
      const fields = {
        fullName: `Tsering Dolma ${t}`,
        email,
        phone: "98765 43210",
        school: w.school,
        role: "teacher",
        message: `I teach grade 5 ${t}`,
        website: "",
      };

      const r = await quietNotifications(c, t, [w.padmin], () => requestAccountAction(undefined, form(fields)));
      assert.deepEqual(r, { done: true });

      const { rows: [req] } = await requestsFor(c, email);
      assert.ok(req, "the request is recorded");
      assert.equal(req.email, email.toLowerCase(), "the address is kept lower-cased");
      assert.equal(req.phone, "+919876543210", "the phone number is kept as the programme writes one");
      assert.equal(req.school_id, w.school);
      assert.equal(req.requested_role, "teacher");
      assert.equal(req.status, "pending");

      const { rows: queue } = await c.query(`SELECT * FROM approvals WHERE item_type = 'account_request' AND item_id = $1`, [req.id]);
      assert.equal(queue.length, 1, "with one pending approval");
      assert.equal(queue[0].status, "pending");
      assert.equal(queue[0].submitted_by_user_id, null, "sent by nobody: the person has no account");
      assert.equal(queue[0].note, `I teach grade 5 ${t}`, "the message is the request's note");

      const { rows: told } = await c.query(
        `SELECT subject, body, entity_type, entity_id FROM notifications WHERE user_id = $1 AND kind = 'approval'`,
        [w.padmin],
      );
      const mine = told.filter((n) => n.subject.includes(t));
      assert.equal(mine.length, 1, "the programme admin is told");
      assert.equal(mine[0].subject, `Account request waiting for approval: Tsering Dolma ${t}`);
      assert.equal(mine[0].body, `I teach grade 5 ${t}`);
      assert.deepEqual([mine[0].entity_type, mine[0].entity_id], ["approval", queue[0].id], "and it opens the request");

      const { rows: audit } = await c.query(
        `SELECT user_id, entity_type, metadata FROM audit_log WHERE action = 'account_request.submitted' AND entity_id = $1`,
        [req.id],
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0].user_id, null, "no actor: nobody signed in made it");
      assert.equal(audit[0].entity_type, "account_request");
      assert.deepEqual(audit[0].metadata, { approvalId: queue[0].id, requestedRole: "teacher" });
      // Exactly the keys docs/audit-actions.md documents for it.
      const line = DOC.split("\n").find((l) => l.startsWith("| `account_request.submitted` |"));
      assert.ok(line, "account_request.submitted is documented");
      const keys = new Set([...line.split("|")[3]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]));
      assert.deepEqual(new Set(Object.keys(audit[0].metadata)), keys);
      assert.doesNotMatch(JSON.stringify(audit[0].metadata), /@/, "the address is not in the audit log");

      // The same address again, in another case: the same answer, nothing new.
      const again = await quietNotifications(c, t, [w.padmin], () =>
        requestAccountAction(undefined, form({ ...fields, email: email.toUpperCase() })),
      );
      assert.deepEqual(again, { done: true });
      assert.equal((await requestsFor(c, email)).rowCount, 1, "one pending request per address");
      const { rows: toldAgain } = await c.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND subject LIKE $2`, [w.padmin, `%${t}%`]);
      assert.equal(toldAgain.length, 1, "and nobody is told twice");

      // A bot that fills in the hidden field is told the same, and nothing is kept.
      const botEmail = `bot.${t}@example.test`;
      assert.deepEqual(await requestAccountAction(undefined, form({ ...fields, email: botEmail, website: "https://spam.example" })), { done: true });
      assert.equal((await requestsFor(c, botEmail)).rowCount, 0);

      // A mentor names no school; that is fine.
      const mentorEmail = `mentor.${t}@example.test`;
      const mentor = await quietNotifications(c, t, [w.padmin], () =>
        requestAccountAction(undefined, form({ ...fields, email: mentorEmail, role: "mentor", school: "", phone: "" })),
      );
      assert.deepEqual(mentor, { done: true });
      const { rows: [m] } = await requestsFor(c, mentorEmail);
      assert.equal(m.requested_role, "mentor");
      assert.equal(m.school_id, null);
      assert.equal(m.phone, null);
    } finally {
      request.headers = {};
      await f.cleanup();
    }
  });
});

test("a request that cannot be used is sent back to be corrected, with what was typed, and records nothing", { skip }, async () => {
  const requestAccountAction = await action();
  await withClient(async (c) => {
    const t = tag("arv");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      signIn(null);
      request.headers = { "x-real-ip": freshIp() };
      const base = { fullName: `Padma ${t}`, email: `padma.${t}@example.test`, phone: "", school: w.school, role: "teacher", message: "" };

      const bad = await requestAccountAction(undefined, form({ ...base, email: "not-an-address", school: "" }));
      assert.deepEqual(new Set(bad.invalid), new Set(["email", "school"]), "a teacher names her school");
      assert.equal(bad.values?.fullName, `Padma ${t}`, "what was typed comes back");
      assert.equal(bad.done, undefined);

      const others = await requestAccountAction(
        undefined,
        form({ ...base, fullName: "", phone: "12", role: "super_admin", school: w.closed, message: "x".repeat(2001) }),
      );
      assert.deepEqual(
        new Set(others.invalid),
        new Set(["fullName", "phone", "role", "school", "message"]),
        "no name, a phone that is not one, a role nobody may ask for, a closed school, an over-long message",
      );
      assert.deepEqual(new Set((await requestAccountAction(undefined, form({ ...base, school: randomUUID() }))).invalid), new Set(["school"]));
      assert.equal((await c.query(`SELECT 1 FROM account_requests WHERE email LIKE $1`, [`%${t}%`])).rowCount, 0, "nothing was recorded");
    } finally {
      request.headers = {};
      await f.cleanup();
    }
  });
});

test("requests are throttled per network address, and a refused one records nothing", { skip }, async () => {
  const requestAccountAction = await action();
  await withClient(async (c) => {
    const t = tag("arr");
    const f = fixture(c, t);
    const ip = freshIp();
    f.defer(`DELETE FROM rate_limits WHERE key = $1`, [`account-request:address:${ip}`]);
    try {
      const w = await world(f, t);
      signIn(null);
      request.headers = { "x-real-ip": ip };
      const send = (i: number) =>
        requestAccountAction(
          undefined,
          form({ fullName: `Person ${i} ${t}`, email: `p${i}.${t}@example.test`, phone: "", school: w.school, role: "teacher", message: "" }),
        );
      await quietNotifications(c, t, [w.padmin], async () => {
        for (let i = 0; i < 10; i++) assert.deepEqual(await send(i), { done: true }, `request ${i + 1} of 10`);
        const eleventh = await send(10);
        assert.equal(eleventh.error, "rate_limited");
        assert.equal(eleventh.done, undefined);
        assert.equal(eleventh.values?.email, `p10.${t}@example.test`, "the form keeps what was typed");
      });
      assert.equal((await c.query(`SELECT 1 FROM account_requests WHERE email LIKE $1`, [`%${t}%`])).rowCount, 10);
      assert.equal((await requestsFor(c, `p10.${t}@example.test`)).rowCount, 0);

      // Another address is not held up by this one.
      const other = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
      request.headers = { "x-real-ip": other };
      f.defer(`DELETE FROM rate_limits WHERE key = $1`, [`account-request:address:${other}`]);
      await quietNotifications(c, t, [w.padmin], async () => assert.deepEqual(await send(11), { done: true }));
    } finally {
      request.headers = {};
      await f.cleanup();
    }
  });
});

test("the page lists the active schools, speaks Hindi, and both login screens link to it", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("arp");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      void w;
      signIn(null);
      request.locale = "hi";
      const { default: RequestAccountPage } = await import("../../apps/web/src/app/request-account/page.tsx");
      const html = await render(withAppRouter(await RequestAccountPage()));
      assert.match(html, /<h1[^>]*>खाते का अनुरोध करें<\/h1>/, "the heading is Hindi");
      assert.match(html, /पूरा नाम/);
      assert.match(html, /अनुरोध भेजें/, "and so is the button");
      assert.match(html, new RegExp(`School ${t}`), "an active school is offered");
      assert.doesNotMatch(html, new RegExp(`Closed ${t}`), "a closed one is not");
      assert.match(html, /<option value="teacher"[^>]*>शिक्षक<\/option>/);
      assert.doesNotMatch(html, /value="super_admin"|value="programme_admin"/, "nobody may ask to be an administrator");
      assert.match(html, /name="website"/, "the honeypot is there");
      assert.match(html, /tabindex="-1"/i, "and out of the tab order");
      assert.deepEqual(await phoneLayoutIssues(html), [], "one column that fits a 360px phone");

      const { DesktopLogin } = await import("../../apps/web/src/app/login/DesktopLogin.tsx");
      const { MobileLogin } = await import("../../apps/web/src/app/login/MobileLogin.tsx");
      for (const Shell of [DesktopLogin, MobileLogin]) {
        const login = renderSync(withAppRouter(h(Shell as never, { from: "", emailEnabled: false })));
        assert.match(login, /href="\/request-account"[^>]*>खाते का अनुरोध करें</, `${Shell.name} links to the request form`);
      }
    } finally {
      request.locale = "en";
      await f.cleanup();
    }
  });
});
