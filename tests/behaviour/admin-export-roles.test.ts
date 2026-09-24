// Bulk CSV export of an admin table is an ADMIN action.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// GET /api/admin/data/<entity>/export authorised on entity.readRoles -- the
// list that decides who may SEE the grid -- and several entities list
// non-admins there. The proxy's /admin policy covers the pages, not /api/*, so
// the pages answered 403 while the export answered 200:
//
//   mentor    mentor-pairings: every mentor's full roster, no mentorship
//             grant and no per-mentor scoping (/mentorship and
//             /repo/mentor/[id] scope it to the mentor's own mentees);
//             rtt-attendance: every attendance mark
//   observer  teachers, including every teacher's phone number
//   teacher   classes, subjects, resources, sessions
//
// Executed through the real route handler as each role, against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();

const exportRoute = () => import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
const get = async (entity: string) => {
  const { GET } = await exportRoute();
  return GET(new Request(`http://x/api/admin/data/${entity}/export`), { params: Promise.resolve({ entity }) });
};

test("non-admin roles cannot bulk-export an admin table, whatever the grid lets them read", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("export-roles");
    const f = fixture(c, t);
    try {
      const mentor = await f.user("mentor", "mentor");
      const observer = await f.user("observer", "observer");
      const teacher = await f.user("teacher", "teacher");
      const admin = await f.user("programme_admin", "padmin");
      // Even holding the mentorship password, a mentor may not take the
      // whole programme's roster: that is the scoping /mentorship applies.
      await f.row("section_gate_grants", {
        user_id: mentor,
        gate_slug: "mentorship",
        expires_at: new Date(Date.now() + 3600_000),
      });

      const cases: Array<[string, string, string]> = [
        [mentor, "mentor", "mentor-pairings"],
        [mentor, "mentor", "rtt-attendance"],
        [mentor, "mentor", "teachers"],
        [observer, "observer", "teachers"],
        [teacher, "teacher", "classes"],
        [teacher, "teacher", "sessions"],
      ];
      for (const [id, role, entity] of cases) {
        actAs(id, role);
        const res = await get(entity);
        assert.equal(res.status, 403, `${role} exported ${entity}`);
      }

      actAs(admin, "programme_admin");
      const ok = await get("teachers");
      assert.equal(ok.status, 200, "an administrator still exports");
    } finally {
      await f.cleanup();
    }
  });
});
