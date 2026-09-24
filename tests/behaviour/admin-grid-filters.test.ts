// The grid's column filters work on every column they are offered for.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// buildColumnFilter chose the SQL operator from the ZOD type, and every
// foreign key is z.string().uuid() -- so filtering teachers by School,
// pairings by Mentor, learners by Class and so on ran `uuid ILIKE text`,
// which Postgres has no operator for, and the whole grid 500'd into the error
// boundary (28 filter boxes across 17 of 20 entities; a complete, valid UUID
// failed too). sessions.scheduledDate (z.string() over a DATE column) did the
// same. Date and timestamp columns with no string schema were instead dropped
// SILENTLY, returning the unfiltered table as if the filter had applied.
//
// Executed: the real grid page rendered for a programme_admin against
// Postgres, with the filters in the query string.

import { test } from "node:test";
import assert from "node:assert/strict";
import { render, withAppRouter, elements, attr, request } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const gridPage = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx");

async function grid(entity: string, filters: Record<string, string>): Promise<string> {
  const { default: AdminGridPage } = await gridPage();
  const sp: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) sp[`filter[${k}]`] = v;
  return render(
    withAppRouter(
      await AdminGridPage({ params: Promise.resolve({ entity }), searchParams: Promise.resolve(sp) }),
    ),
  );
}

const cells = (html: string) => elements(html, "td").map((td) => td.text);

test("filtering by a linked row, a date or text narrows the grid instead of crashing it", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("grid-filter");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const s1 = await f.row("schools", { zone_id: zone, name: `One ${t}`, code: `${t.slice(-10)}a` });
      const s2 = await f.row("schools", { zone_id: zone, name: `Two ${t}`, code: `${t.slice(-10)}b` });
      const t1 = await f.row("teachers", { school_id: s1, full_name: `T1 ${t}` });
      await f.row("teachers", { school_id: s2, full_name: `T2 ${t}` });
      const subject = await f.row("subjects", { name: `Subj ${t}`, code: `S${t.slice(-6).toUpperCase()}` });
      const klass = await f.row("classes", { school_id: s1, grade: 5, stage: "Primary" });
      await f.row("sessions", { school_id: s1, class_id: klass, subject_id: subject, teacher_id: t1, scheduled_date: "2026-10-01", topic: `Topic ${t}` });
      await f.row("sessions", { school_id: s1, class_id: klass, subject_id: subject, teacher_id: t1, scheduled_date: "2026-10-02", topic: `Other ${t}` });
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      request.cookies = { "gml-device": "desktop" };

      // A foreign key, by its UUID -- what the filter's picker submits.
      const bySchool = cells(await grid("teachers", { schoolId: s1 }));
      assert.ok(bySchool.includes(`T1 ${t}`), "the teacher at the chosen school is listed");
      assert.ok(!bySchool.includes(`T2 ${t}`), "a teacher at another school is not");

      // A DATE column.
      const byDate = cells(await grid("sessions", { scheduledDate: "2026-10-01", topic: t }));
      assert.ok(byDate.includes(`Topic ${t}`));
      assert.ok(!byDate.includes(`Other ${t}`), "the date filter must narrow, not be dropped");

      // Text, with LIKE wildcards taken literally.
      const byText = cells(await grid("teachers", { fullName: `T_ ${t}` }));
      assert.ok(!byText.includes(`T1 ${t}`), "an underscore in a filter is a literal underscore");
    } finally {
      await f.cleanup();
    }
  });
});

test("a filter value that cannot apply is reported on screen, not silently dropped or fatal", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("grid-filter-bad");
    const f = fixture(c, t);
    try {
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      request.cookies = { "gml-device": "desktop" };
      const html = await grid("teachers", { schoolId: "a" });
      const notice = elements(html, "p").find((p) => attr(p.open, "data-testid") === "grid-filters-skipped");
      assert.ok(notice, "the page must say the filter was ignored");
      assert.match(notice.text, /School/);

      const zones = await grid("zones", { createdAt: "not a date" });
      assert.ok(
        elements(zones, "p").some((p) => attr(p.open, "data-testid") === "grid-filters-skipped"),
        "an unusable date filter must not return the unfiltered table unannounced",
      );
    } finally {
      await f.cleanup();
    }
  });
});

test("a foreign-key column's filter is a picker of the rows it can point at", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("grid-filter-pick");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `Pick ${t}`, code: t.slice(-12) });
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      request.cookies = { "gml-device": "desktop" };
      const html = await grid("teachers", {});
      const pick = elements(html, "select").find((s) => attr(s.open, "name") === "filter[schoolId]");
      assert.ok(pick, "the School filter is a <select>, not a 'contains…' box that 500s");
      assert.match(pick.inner, new RegExp(`value="${school}">Pick ${t}`));
    } finally {
      await f.cleanup();
    }
  });
});
