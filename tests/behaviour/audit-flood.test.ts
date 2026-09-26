// A signed-in caller cannot grow the append-only audit log without bound
// through Cmd+K or the PDF viewer's beacon.
//
// ── F97 (quickfind and resource-view) ────────────────────────────────────────
//
// audit_log is append-only by trigger and never pruned, so every row a caller
// can make it write is a row the operator keeps forever. Two routes wrote one
// per request with nothing in front of them:
//
//   GET  /api/quickfind           one `quickfind.query` row per call, holding
//                                 the whole `q` -- a 6,000-character q was
//                                 searched, echoed and stored.
//   POST /api/audit/resource-view one `resource.view.client_ping` row per call
//                                 for any well-formed uuid (the beacon does
//                                 not look the resource up, by design), and
//                                 metadata.viewerId was whatever the client
//                                 sent -- a forensic record naming a viewer
//                                 the server never checked.
//
// The client-beacon route beside them was rate-limited for exactly this
// reason; these two were not. (The unsigned-webhook share of F97 is fixed and
// tested in whatsapp-signature.test.ts.)
//
// Executed: the real route handlers, as a signed-in teacher, against Postgres;
// the rows counted are that teacher's own.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, type Fixture } from "./_admin-fixture.js";
import { closeAppPool } from "./_mentorship.js";
import { withRowFault } from "./_fake_gotrue.js";

const skip = needsDatabase();
after(closeAppPool);

const quickfind = async (q: string) => {
  const { GET } = await import("../../apps/web/src/app/api/quickfind/route.ts");
  return GET(new Request(`http://x/api/quickfind?q=${encodeURIComponent(q)}`));
};

const ping = async (body: Record<string, unknown>) => {
  const { POST } = await import("../../apps/web/src/app/api/audit/resource-view/route.ts");
  return POST(
    new Request("http://x/api/audit/resource-view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};

type Row = { metadata: Record<string, unknown>; entity_id: string | null };

/**
 * This user's rows for `action`, once the voided recordAudit() inserts the
 * routes fire have landed: read until two reads 150 ms apart agree, and --
 * when the test knows rows are coming -- until at least `expect` are there.
 * Two agreeing reads alone could both come before a slow insert under a
 * loaded suite, and a count of 0 then failed a test whose route was right.
 */
async function auditRows(c: Client, userId: string, action: string, expect = 0): Promise<Row[]> {
  const read = async () =>
    (await c.query<Row>(`SELECT metadata, entity_id FROM audit_log WHERE user_id = $1 AND action = $2`, [userId, action])).rows;
  let prev = await read();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const next = await read();
    if (next.length === prev.length && next.length >= expect) return next;
    prev = next;
  }
  return prev;
}

/** A teacher signed in for this test, with its rate-limit counters removed afterwards. */
async function teacher(f: Fixture): Promise<string> {
  const id = await f.user("teacher", "teacher");
  f.defer(`DELETE FROM rate_limits WHERE key LIKE $1`, [`%:${id}`]);
  actAs(id, "teacher");
  return id;
}

// ── /api/quickfind ───────────────────────────────────────────────────────────
//
// The length cap sits at the longest value the route searches, so a query it
// refuses is one that could not have matched anything.
//
// The throttle is sized for the log. It used to have to sit above the most
// searches one palette can send (ceil(60 s / 180 ms debounce) = 334 a minute,
// so 400), because QuickFind rendered ANY non-200 as "No results for <q>": a
// bound an honest user could reach told them a teacher or school did not
// exist. That let one account write 576,000 permanent rows a day. The palette
// now says "Too many searches -- try again in N s" instead
// (quickfind-refusals.test.ts), so the limit can be one a person looking
// names up does not meet and a loop meets at once.

test("F97 quickfind: an over-long query is refused, and neither searched nor stored", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("qf-long"));
    try {
      const me = await teacher(f);
      const res = await quickfind(`zz${"x".repeat(6000)}`);
      assert.equal(res.status, 400, "a 6,000-character query was searched");
      assert.equal(((await res.json()) as { error?: string }).error, "query_too_long");
      assert.equal((await auditRows(c, me, "quickfind.query")).length, 0, "the refused query reached the audit log");
    } finally {
      await f.cleanup();
    }
  });
});

test("F97 quickfind: the longest value it searches, pasted whole, is found; one character more is refused", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("qf-paste");
    const f = fixture(c, t);
    try {
      // sessions.topic is varchar(240), the widest column quickfind searches.
      // A full-length topic, with one character outside the BMP: Postgres
      // counts it as one character and JavaScript's .length as two, and a
      // topic typed on a phone can carry one.
      const prefix = `${t} \u{1F4D8} fractions on a number line `;
      const topic = prefix + "x".repeat(240 - [...prefix].length);
      assert.equal([...topic].length, 240);
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const klass = await f.row("classes", { school_id: school, grade: 5, stage: "Primary" });
      const subject = await f.row("subjects", { name: `Subject ${t}`, code: t.slice(-12) });
      const tch = await f.row("teachers", { school_id: school, full_name: `T ${t}` });
      const session = await f.row("sessions", {
        school_id: school,
        class_id: klass,
        subject_id: subject,
        teacher_id: tch,
        scheduled_date: "2026-09-01",
        topic,
      });
      const me = await teacher(f);

      const res = await quickfind(topic);
      assert.equal(
        res.status,
        200,
        `a session's whole topic, pasted into Cmd+K, was refused with ${res.status} -- the palette shows that as "No results"`,
      );
      const body = (await res.json()) as { results: Array<{ kind: string; id: string }> };
      assert.deepEqual(
        body.results.filter((r) => r.kind === "session").map((r) => r.id),
        [session],
        "the session whose topic was searched for was not found",
      );

      // Longer than anything searched, so it could not have matched: refused.
      const over = await quickfind(`${topic}x`);
      assert.equal(over.status, 400, "a query longer than any searchable value was searched");

      // What F97 needs: the served search is one row, the refused one none.
      // What the row holds is the taxonomy's contract, pinned against
      // docs/audit-actions.md in audit-doc-metadata.test.ts (W3-25).
      const rows = await auditRows(c, me, "quickfind.query", 1);
      assert.equal(rows.length, 1, "the served search is audited once, the refused one not at all");
      assert.equal(rows[0]!.metadata.resultCount, 1);
    } finally {
      await f.cleanup();
    }
  });
});

/**
 * A person looking names up: eight 15-character names in a minute at one
 * search per character, which is what the palette sends at phone typing speed
 * (300-500 ms a character, slower than its 180 ms debounce). Twice the four
 * lookups that filled the original limit of 60.
 */
const PERSON_PER_MINUTE = 8 * 15;
/** The most quickfind.query rows one account may add in a minute: 216,000 a day at most. */
const LOG_CEILING_PER_MINUTE = 150;

test("F97/W3-26 quickfind: a person looking names up is not throttled, a loop is, well under the old 400 a minute, and every search served is audited", { skip, timeout: 120_000 }, async () => {
  await withClient(async (c) => {
    const t = tag("qf-flood");
    const f = fixture(c, t);
    try {
      const me = await teacher(f);
      // Open this user's window as if they had already sent all but the last
      // of a person's searches for the minute, rather than make that many real
      // calls. (The counter is keyed `<bucket>:<user id>` by lib/rate-limit.)
      const seededAt = Date.now();
      await c.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), $2)`, [
        `quickfind:${me}`,
        PERSON_PER_MINUTE - 1,
      ]);

      const served: number[] = [];
      let limited: Response | null = null;
      for (let i = 0; i < 400 && !limited; i++) {
        const res = await quickfind(`${t}-${i}`);
        if (res.status === 429) limited = res;
        else served.push(res.status);
      }
      assert.ok(served.length > 0, `search ${PERSON_PER_MINUTE} of a minute was throttled: a person looking up eight names meets the limit`);
      assert.ok(limited, `${PERSON_PER_MINUTE - 1 + served.length} searches in one window were all served`);
      assert.deepEqual(new Set(served), new Set([200]), `unexpected statuses: ${served.join(",")}`);

      // The window, measured: time since it opened plus what the 429 says is
      // left of it. What that lets one account write, per minute, is bounded.
      const body = (await limited.json()) as { error: string; retryAfterMs: number };
      assert.equal(body.error, "rate_limited");
      const windowMs = Date.now() - seededAt + body.retryAfterMs;
      const limit = PERSON_PER_MINUTE - 1 + served.length;
      const perMinute = Math.round((limit * 60_000) / windowMs);
      assert.ok(
        perMinute <= LOG_CEILING_PER_MINUTE,
        `the limit (${limit} per ${windowMs} ms) lets one account add ${perMinute} permanent audit rows a minute`,
      );

      // Every search that was answered is in the log; none that was refused is.
      assert.equal((await auditRows(c, me, "quickfind.query", served.length)).length, served.length);
      const again = await quickfind(`${t}-after`);
      assert.equal(again.status, 429, "a search was served after the throttle engaged");
      assert.ok(Number(again.headers.get("retry-after")) > 0, "a 429 says when to retry");
    } finally {
      await f.cleanup();
    }
  });
});

// ── /api/audit/resource-view ─────────────────────────────────────────────────

test("F97 resource-view: the beacon is throttled per user", { skip, timeout: 120_000 }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("rv-flood"));
    try {
      const me = await teacher(f);
      const statuses: number[] = [];
      // Unknown ids on purpose: the beacon never looks a resource up, so this
      // is exactly what a script cycling random uuids gets.
      for (let i = 0; i < 50; i++) statuses.push((await ping({ resourceId: randomUUID() })).status);

      const served = statuses.filter((s) => s === 204).length;
      assert.ok(statuses.includes(429), `50 beacons in a row were all recorded: ${statuses.join(",")}`);
      assert.equal(statuses.indexOf(429), served, "a beacon was recorded after the throttle engaged");
      assert.ok(served >= 10, `only ${served} beacons were recorded before the throttle`);
      assert.equal((await auditRows(c, me, "resource.view.client_ping", served)).length, served);
    } finally {
      await f.cleanup();
    }
  });
});

test("F97 resource-view: the viewer recorded is the session's, never a client-supplied viewerId", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("rv-viewer"));
    try {
      const me = await teacher(f);
      const resourceId = randomUUID();
      const res = await ping({ id: resourceId, viewerId: "someone-else@example.test" });
      assert.equal(res.status, 204, "a client that still sends viewerId is not refused");

      const rows = await auditRows(c, me, "resource.view.client_ping", 1);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.entity_id, resourceId);
      assert.ok(
        !JSON.stringify(rows[0]!.metadata).includes("someone-else"),
        `the client's claimed viewer was written into the forensic log: ${JSON.stringify(rows[0]!.metadata)}`,
      );
    } finally {
      await f.cleanup();
    }
  });
});

// ── fail closed ──────────────────────────────────────────────────────────────

test("W3-26 quickfind and resource-view: when the limiter cannot count, they refuse with 503 and write nothing", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("rl-down"));
    try {
      const me = await teacher(f);
      // The counter's write fails for this user's keys only, so files running
      // alongside against the same database are unaffected.
      await withRowFault(c, "rate_limits", "INSERT", `NEW.key LIKE '%:${me}'`, async () => {
        const qf = await quickfind("Tsering");
        assert.equal(qf.status, 503, "quickfind searched with its throttle down");
        assert.deepEqual(await qf.json(), { error: "rate_limit_unavailable" });
        const rv = await ping({ resourceId: randomUUID() });
        assert.equal(rv.status, 503, "the beacon was recorded with its throttle down");
        assert.deepEqual(await rv.json(), { error: "rate_limit_unavailable" });
      });
      assert.equal((await auditRows(c, me, "quickfind.query")).length, 0, "an unthrottled search was audited");
      assert.equal((await auditRows(c, me, "resource.view.client_ping")).length, 0, "an unthrottled beacon was audited");
    } finally {
      await f.cleanup();
    }
  });
});

// ── /api/helpdesk/tickets ────────────────────────────────────────────────────
//
// W3-06, the F97 case the other routes missed: the ticket throttle stopped the
// notifications but wrote a helpdesk.ticket_rate_limited row for EVERY refused
// POST, so a loop past the limit grew the log one permanent row per request
// for the rest of the hour.

const helpdesk = async () => {
  const { POST } = await import("../../apps/web/src/app/api/helpdesk/tickets/route.ts");
  return POST(
    new Request("http://x/api/helpdesk/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "flood", pageSlug: "/dashboard" }),
    }),
  );
};

test("W3-06 helpdesk: a caller over the ticket limit is refused every time and audited once per window", { skip, timeout: 120_000 }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("hd-flood"));
    try {
      const me = await teacher(f);
      // This user's hour already holds the five tickets the route allows, so
      // no request here opens a ticket or notifies an administrator.
      await c.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 5)`, [`helpdesk:${me}`]);

      const serial: Response[] = [];
      for (let i = 0; i < 25; i++) serial.push(await helpdesk());
      // And a burst, which a read-then-insert dedup lets most of through.
      const burst = await Promise.all(Array.from({ length: 25 }, () => helpdesk()));

      for (const res of [...serial, ...burst]) {
        assert.equal(res.status, 429, "a POST over the ticket limit was not refused");
        assert.ok(Number(res.headers.get("retry-after")) > 0, "a 429 says when to retry");
      }
      assert.equal(
        (await auditRows(c, me, "helpdesk.ticket_opened")).length,
        0,
        "a refused POST opened a ticket",
      );
      const rows = await auditRows(c, me, "helpdesk.ticket_rate_limited", 1);
      assert.equal(rows.length, 1, `50 refused POSTs wrote ${rows.length} permanent audit rows`);
      assert.equal(rows[0]!.entity_id, me);
      assert.equal(typeof rows[0]!.metadata.retryAfterMs, "number");
    } finally {
      await f.cleanup();
    }
  });
});
