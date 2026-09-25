// The audit-log export refuses a ?from= / ?to= it cannot read, instead of
// exporting as if it had not been given.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// GET /api/admin/audit/export built `new Date(param)` and added the bound only
// when that parsed. A typo'd date (2026-13-01, "yesterday", 2026-09-0l) was
// dropped without a word, so the file covered a wider window than asked for
// -- up to the whole log -- and the audit.bulk_export row recorded the typo'd
// bound as a filter the query never applied. JS Date is also lenient where it
// does parse: 01/09/2026 read as 9 January in the server's zone, 2026-02-30
// rolled over to 2 March, and "5" meant the year 2001. The same handler
// already answered 400 for a bad ?userId.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real route handler, as a super_admin holding the admin section grant,
// against audit rows planted at known times.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();

test("an unreadable ?from or ?to is a 400, and a readable one bounds the export", { skip }, async () => {
  const { GET } = await import("../../apps/web/src/app/api/admin/audit/export/route.ts");
  await withClient(async (c) => {
    const t = tag("audit-dates");
    const f = fixture(c, t);
    try {
      const admin = await f.user("super_admin", "sadmin");
      await f.row("section_gate_grants", { user_id: admin, gate_slug: "admin", expires_at: new Date(Date.now() + 3600_000) });
      // audit_log is append-only: these stay behind, tagged by entity_type.
      for (const [id, at] of [
        ["early", "2026-08-01T00:00:00Z"],
        ["mid", "2026-08-15T00:00:00Z"],
        ["late", "2026-09-01T00:00:00Z"],
      ]) {
        await c.query(`INSERT INTO audit_log (action, entity_type, entity_id, created_at) VALUES ('test.dated', $1, $2, $3)`, [t, id, at]);
      }
      actAs(admin, "super_admin");
      const exportsRecorded = async () =>
        (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'audit.bulk_export' AND metadata->'filters'->>'entityType' = $1`, [t]))
          .rows[0].n as number;
      const get = (qs: Record<string, string>) =>
        GET(new Request(`http://x/api/admin/audit/export?${new URLSearchParams({ entityType: t, ...qs })}`));
      const idsIn = async (res: Response) =>
        [...(await res.text()).matchAll(/test\.dated,[^,]*,[^,]*,(early|mid|late)/g)].map((m) => m[1]).sort();

      const refused: string[] = [];
      for (const [param, value] of [
        ["from", "2026-13-01"],
        ["from", "2026-09-0l"],
        ["from", "01/09/2026"],
        ["from", "2026-02-30"],
        ["from", "2026-02-30T00:00:00Z"],
        ["from", "5"],
        ["to", "yesterday"],
        ["to", "2026-09-01T24:00:00Z"],
      ] as const) {
        const res = await get({ [param]: value });
        const body = res.status === 400 ? ((await res.json()) as { error?: string }) : null;
        if (res.status !== 400 || body?.error !== `invalid_${param}`) refused.push(`?${param}=${value} answered ${res.status} ${JSON.stringify(body)}`);
      }
      assert.deepEqual(refused, [], "an unreadable bound must be refused, not dropped");
      assert.equal(await exportsRecorded(), 0, "a refused export records no audit.bulk_export row");

      // Readable bounds: an ISO instant, and a calendar day (IST, as the
      // admin/audit page and the grid mean one).
      const instant = await get({ from: "2026-08-10T00:00:00.000Z", to: "2026-08-20T00:00:00Z" });
      assert.equal(instant.status, 200);
      assert.deepEqual(await idsIn(instant), ["mid"]);
      const day = await get({ from: "2026-08-15", to: "2026-08-16" });
      assert.equal(day.status, 200);
      assert.deepEqual(await idsIn(day), ["mid"], "15 Aug 00:00Z is 05:30 IST on the 15th");
      const open = await get({ to: "2026-08-15T00:00:00+05:30" });
      assert.deepEqual(await idsIn(open), ["early"]);
      assert.equal(await exportsRecorded(), 3);
    } finally {
      await f.cleanup();
    }
  });
});
