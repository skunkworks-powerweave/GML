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
 * routes fire have landed: read until two reads 150 ms apart agree.
 */
async function auditRows(c: Client, userId: string, action: string): Promise<Row[]> {
  const read = async () =>
    (await c.query<Row>(`SELECT metadata, entity_id FROM audit_log WHERE user_id = $1 AND action = $2`, [userId, action])).rows;
  let prev = await read();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const next = await read();
    if (next.length === prev.length) return next;
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
// Both bounds are sized to the palette, because QuickFind (components/
// quickfind/QuickFind.tsx) renders ANY non-200 as "No results for <q>". A
// bound an honest user can reach tells them a teacher or school does not
// exist -- and an admin checking a list may then create a duplicate. So:
//
//   - the length cap sits at the longest value the route searches, so a query
//     it refuses is one that could not have matched anything;
//   - the throttle sits above the most searches one palette can send in a
//     window, so only something other than a person typing reaches it.

/**
 * QuickFind's debounce, read from the component. The palette is a separate
 * program, and the fastest it can call this route is what sizes the limit;
 * reading it here means shortening it cannot silently cross the throttle.
 */
async function clientDebounceMs(): Promise<number> {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../apps/web/src/components/quickfind/QuickFind.tsx", import.meta.url), "utf8");
  const m = /\bconst DEBOUNCE_MS = (\d+);/.exec(src);
  assert.ok(m, "QuickFind.tsx no longer declares `const DEBOUNCE_MS = <n>;` -- update clientDebounceMs()");
  return Number(m[1]);
}

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

      // PROVISIONAL: the row stores the raw q as typed. docs/audit-actions.md
      // documents quickfind.query as length only, NOT raw text (privacy), and
      // product has not yet decided which is right. This pin records current
      // behaviour; change it with that decision, not around it.
      const rows = await auditRows(c, me, "quickfind.query");
      assert.deepEqual(
        rows.map((r) => r.metadata.q),
        [topic],
        "the served search is audited once, the refused one not at all",
      );
    } finally {
      await f.cleanup();
    }
  });
});

test("F97 quickfind: a person typing is never throttled, a loop is, and every search served is audited", { skip, timeout: 120_000 }, async () => {
  const debounceMs = await clientDebounceMs();
  await withClient(async (c) => {
    const t = tag("qf-flood");
    const f = fixture(c, t);
    try {
      const me = await teacher(f);
      // QuickFind searches whenever typing pauses for debounceMs, and at phone
      // typing speed (300-500 ms a character) that is after every character:
      // one palette can send a search every debounceMs for a whole window.
      // Open this user's window as if they had done exactly that up to their
      // last search, rather than make several hundred real calls. (The counter
      // is keyed `<bucket>:<user id>` by lib/rate-limit.)
      const human = Math.ceil(60_000 / debounceMs);
      const seededAt = Date.now();
      await c.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), $2)`, [
        `quickfind:${me}`,
        human - 1,
      ]);

      const served: number[] = [];
      let limited: Response | null = null;
      for (let i = 0; i < 300 && !limited; i++) {
        const res = await quickfind(`${t}-${i}`);
        if (res.status === 429) limited = res;
        else served.push(res.status);
      }
      assert.ok(
        served.length > 0,
        `search ${human} of one window was throttled, and QuickFind (debounce ${debounceMs} ms) sends that many ` +
          `while a person types -- the palette shows the 429 as "No results"`,
      );
      assert.ok(limited, `${human - 1 + served.length} searches in one window were all served`);
      assert.deepEqual(new Set(served), new Set([200]), `unexpected statuses: ${served.join(",")}`);

      // The window, measured: time since it opened plus what the 429 says is
      // left of it. One palette's worst case over that window fits the limit.
      const { retryAfterMs } = (await limited.json()) as { retryAfterMs: number };
      const windowMs = Date.now() - seededAt + retryAfterMs;
      const limit = human - 1 + served.length;
      assert.ok(
        limit >= Math.ceil(windowMs / debounceMs),
        `the limit (${limit} per ${windowMs} ms) is below what one QuickFind palette sends in that time`,
      );

      // Every search that was answered is in the log; none that was refused is.
      assert.equal((await auditRows(c, me, "quickfind.query")).length, served.length);
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
      assert.equal((await auditRows(c, me, "resource.view.client_ping")).length, served);
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
      const rows = await auditRows(c, me, "helpdesk.ticket_rate_limited");
      assert.equal(rows.length, 1, `50 refused POSTs wrote ${rows.length} permanent audit rows`);
      assert.equal(rows[0]!.entity_id, me);
      assert.equal(typeof rows[0]!.metadata.retryAfterMs, "number");
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

      const rows = await auditRows(c, me, "resource.view.client_ping");
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
