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

test("F97 quickfind: an over-long query is refused, and neither searched nor stored", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("qf-long"));
    try {
      const me = await teacher(f);
      const res = await quickfind(`zz${"x".repeat(6000)}`);
      assert.equal(res.status, 400, "a 6,000-character query was searched");
      assert.equal(((await res.json()) as { error?: string }).error, "query_too_long");
      assert.equal((await auditRows(c, me, "quickfind.query")).length, 0, "the refused query reached the audit log");

      // A query at the cap is an ordinary search, audited as typed.
      const atCap = `zz${"y".repeat(98)}`;
      const ok = await quickfind(atCap);
      assert.equal(ok.status, 200);
      const rows = await auditRows(c, me, "quickfind.query");
      assert.deepEqual(rows.map((r) => r.metadata.q), [atCap]);
    } finally {
      await f.cleanup();
    }
  });
});

test("F97 quickfind: one user's searches are throttled, and every search served is audited", { skip, timeout: 120_000 }, async () => {
  await withClient(async (c) => {
    const t = tag("qf-flood");
    const f = fixture(c, t);
    try {
      const me = await teacher(f);
      const statuses: number[] = [];
      for (let i = 0; i < 80; i++) statuses.push((await quickfind(`${t}-${i}`)).status);

      const served = statuses.filter((s) => s === 200).length;
      assert.ok(statuses.includes(429), `80 searches in a row were all served: ${statuses.join(",")}`);
      assert.deepEqual(new Set(statuses), new Set([200, 429]), `unexpected statuses: ${statuses.join(",")}`);
      // Once throttled, every later call in the window is throttled too.
      assert.equal(statuses.indexOf(429), served, "a search was served after the throttle engaged");
      // Far above what a person typing (debounced 180 ms) reaches in a minute.
      assert.ok(served >= 40, `only ${served} searches were served before the throttle`);

      // Every search that was answered is in the log; none that was refused is.
      const rows = await auditRows(c, me, "quickfind.query");
      assert.equal(rows.length, served);
      const limited = await quickfind(`${t}-after`);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0, "a 429 says when to retry");
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
