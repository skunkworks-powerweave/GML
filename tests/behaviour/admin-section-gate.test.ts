// Gated rows stay gated when they are served through the admin grid.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// /observation and /mentorship sit behind section passwords, and
// lib/visibility.ts says a surface that re-serves those rows elsewhere must
// apply the gate too. The admin grid's observation-cycles and mentor-pairings
// entities checked the ROLE only, in the grid page, all four row actions and
// the CSV import/export routes. A programme_admin who had never unlocked the
// section -- or whose grant a password rotation had just revoked -- could list
// every cycle, export them all, and create, alter or delete them. The grid and
// the CSV import also skipped /observation/new's "the observer must be a live
// observer account" rule, so a cycle could be pointed at a mentor.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real page, server actions and route handlers, as a real programme_admin,
// with and without a section_gate_grants row, against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form, redirectOf, type Fixture } from "./_admin-fixture.js";

const skip = needsDatabase();

const DATA = "../../apps/web/src/app/(authenticated)/admin/data/[entity]";
const actions = () => import(`${DATA}/actions.ts`);
const page = () => import(`${DATA}/page.tsx`);
const exportRoute = () => import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
const importRoute = () => import("../../apps/web/src/app/api/admin/data/[entity]/import/route.ts");

async function world(f: Fixture, t: string) {
  const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
  const teacher = await f.row("teachers", { school_id: school, full_name: `T ${t}` });
  const observer = await f.user("observer", "observer");
  const mentorUser = await f.user("mentor", "mentor");
  const admin = await f.user("programme_admin", "padmin");
  const cycle = await f.row("observation_cycles", {
    code: `OBS-${t}`,
    teacher_id: teacher,
    observer_id: observer,
    kind: "baseline",
    status: "nominated",
  });
  const mentor = await f.row("mentors", { name: `M ${t}` });
  const pairing = await f.row("mentor_pairings", { mentor_id: mentor, teacher_id: teacher });
  // Rows the actions/imports may create, so cleanup finds them.
  f.defer(`DELETE FROM observation_cycles WHERE code LIKE $1`, [`NEW-${t}%`]);
  return { teacher, observer, mentorUser, admin, cycle, pairing };
}

const grant = (f: Fixture, userId: string, slug: string) =>
  f.row("section_gate_grants", { user_id: userId, gate_slug: slug, expires_at: new Date(Date.now() + 3600_000) });

const ctx = (entity: string) => ({ params: Promise.resolve({ entity }) });

test("without the observation password, the grid, the export and the import all refuse observation cycles", { skip }, async () => {
  const { default: AdminGridPage } = await page();
  const { GET } = await exportRoute();
  const { POST } = await importRoute();
  await withClient(async (c) => {
    const t = tag("gate-obs");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.admin, "programme_admin");
      request.cookies = { "gml-device": "desktop" };

      const where = await redirectOf(
        AdminGridPage({ params: Promise.resolve({ entity: "observation-cycles" }), searchParams: Promise.resolve({}) }),
      );
      assert.equal(
        where,
        `/gate/observation?next=${encodeURIComponent("/admin/data/observation-cycles")}`,
        "the grid must send an ungranted admin to the observation gate",
      );

      const exp = await GET(new Request("http://x/api/admin/data/observation-cycles/export"), ctx("observation-cycles"));
      assert.equal(exp.status, 403, "the export must refuse without the observation grant");
      assert.deepEqual(await exp.json(), { error: "gate_required", gate: "observation" });

      const csv = `code,teacherId,observerId,kind,scheduledAt\nNEW-${t}-imp,${w.teacher},${w.observer},baseline,2026-10-01T09:00:00Z\n`;
      const imp = await POST(
        new Request("http://x/api/admin/data/observation-cycles/import", { method: "POST", body: csv }),
        ctx("observation-cycles"),
      );
      assert.equal(imp.status, 403, "the import must refuse without the observation grant");
      const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM observation_cycles WHERE code = $1`, [`NEW-${t}-imp`]);
      assert.equal(n.n, 0, "nothing may be imported through a closed gate");
    } finally {
      await f.cleanup();
    }
  });
});

test("without the observation password, the row actions refuse too", { skip }, async () => {
  const { createRowAction, updateRowAction, deleteRowAction, bulkDeleteAction } = await actions();
  await withClient(async (c) => {
    const t = tag("gate-act");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.admin, "programme_admin");
      const gateUrl = `/gate/observation?next=${encodeURIComponent("/admin/data/observation-cycles")}`;

      const created = await redirectOf(
        createRowAction(
          undefined,
          form({
            entitySlug: "observation-cycles",
            code: `NEW-${t}-c`,
            teacherId: w.teacher,
            observerId: w.observer,
            kind: "baseline",
            scheduledAt: "2026-10-01",
          }),
        ),
      );
      assert.equal(created, gateUrl);
      const updated = await redirectOf(
        updateRowAction(
          undefined,
          form({
            entitySlug: "observation-cycles",
            rowId: w.cycle,
            code: `OBS-${t}`,
            teacherId: w.teacher,
            observerId: w.observer,
            kind: "evaluative",
            scheduledAt: "2026-10-01",
          }),
        ),
      );
      assert.equal(updated, gateUrl);
      assert.equal(await redirectOf(deleteRowAction(form({ entitySlug: "observation-cycles", rowId: w.cycle }))), gateUrl);
      assert.equal(
        await redirectOf(bulkDeleteAction(form({ entitySlug: "observation-cycles", rowIds: [w.cycle] }))),
        gateUrl,
      );

      const { rows: [row] } = await c.query(`SELECT kind FROM observation_cycles WHERE id = $1`, [w.cycle]);
      assert.equal(row?.kind, "baseline", "the cycle must be untouched");
      const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM observation_cycles WHERE code = $1`, [`NEW-${t}-c`]);
      assert.equal(n.n, 0);
    } finally {
      await f.cleanup();
    }
  });
});

test("the mentor-pairing roster needs the mentorship password to export", { skip }, async () => {
  const { GET } = await exportRoute();
  await withClient(async (c) => {
    const t = tag("gate-mnt");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.admin, "programme_admin");
      const res = await GET(new Request("http://x/api/admin/data/mentor-pairings/export"), ctx("mentor-pairings"));
      assert.equal(res.status, 403);
      await grant(f, w.admin, "mentorship");
      const ok = await GET(new Request("http://x/api/admin/data/mentor-pairings/export"), ctx("mentor-pairings"));
      assert.equal(ok.status, 200, "with the grant the export works");
    } finally {
      await f.cleanup();
    }
  });
});

test("with the password, a cycle still cannot be pointed at an account that is not a live observer", { skip }, async () => {
  const { createRowAction } = await actions();
  const { GET } = await exportRoute();
  const { POST } = await importRoute();
  await withClient(async (c) => {
    const t = tag("gate-obsr");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.admin, "programme_admin");
      await grant(f, w.admin, "observation");

      const exp = await GET(new Request("http://x/api/admin/data/observation-cycles/export"), ctx("observation-cycles"));
      assert.equal(exp.status, 200, "with the grant the export works");

      const bad = await createRowAction(
        undefined,
        form({
          entitySlug: "observation-cycles",
          code: `NEW-${t}-m`,
          teacherId: w.teacher,
          observerId: w.mentorUser,
          kind: "baseline",
          scheduledAt: "2026-10-01",
        }),
      );
      assert.equal(bad?.ok, false, "a mentor account was accepted as the observer");
      assert.ok(bad?.fieldErrors?.observerId, "the error belongs to the observer field");

      const csv =
        `code,teacherId,observerId,kind,scheduledAt\n` +
        `NEW-${t}-i1,${w.teacher},${w.mentorUser},baseline,2026-10-01T09:00:00Z\n` +
        `NEW-${t}-i2,${w.teacher},${w.observer},baseline,2026-10-02T09:00:00Z\n`;
      const imp = await POST(
        new Request("http://x/api/admin/data/observation-cycles/import", { method: "POST", body: csv }),
        ctx("observation-cycles"),
      );
      const body = (await imp.json()) as { inserted: number; errors: Array<{ row: number; message: string }> };
      assert.equal(body.inserted, 1, "the valid row lands");
      assert.equal(body.errors[0]?.row, 2, "the mentor row is reported against its spreadsheet line");
      assert.match(body.errors[0]?.message ?? "", /observer/i);
      const { rows } = await c.query(`SELECT code FROM observation_cycles WHERE code LIKE $1 ORDER BY code`, [`NEW-${t}%`]);
      assert.deepEqual(rows.map((r) => r.code), [`NEW-${t}-i2`]);
    } finally {
      await f.cleanup();
    }
  });
});
