// Re-importing an edited export updates the rows it came from.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The export writes each row's id first; the import ignored it (it is not a
// form field) and only ever INSERTED. The natural spreadsheet workflow --
// export the roster, fix phone numbers or schools in Excel, import it back --
// therefore created a second copy of every row, updated nothing, and reported
// ok:true. The duplicates then showed up in "Awaiting an account", in pairing
// pickers and in every count.
//
// Executed: the real export route and importCsv, as a super_admin, against
// Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const Papa = createRequire(new URL("../../apps/web/package.json", import.meta.url))("papaparse") as {
  parse: (s: string, o: { header: boolean; skipEmptyLines: boolean }) => { data: Record<string, string>[] };
  unparse: (d: { fields: string[]; data: Record<string, string>[] }) => string;
};

test("export -> edit -> import updates the exported rows instead of duplicating them", { skip }, async () => {
  const { GET } = await import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("csv-upsert");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      f.defer(`DELETE FROM teachers WHERE full_name LIKE $1`, [`% ${t}`]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const first = await importCsv(
        "teachers",
        `fullName,schoolId,phone\nOne ${t},${school},+91 900\nTwo ${t},${school},+91 901\n`,
      );
      assert.equal(first.inserted, 2);

      const res = await GET(new Request("http://x/api/admin/data/teachers/export"), { params: Promise.resolve({ entity: "teachers" }) });
      const exported = Papa.parse(await res.text(), { header: true, skipEmptyLines: true });
      const mine = exported.data.filter((r) => r.fullName?.endsWith(` ${t}`));
      assert.equal(mine.length, 2);
      for (const r of mine) if (r.fullName === `One ${t}`) r.phone = "+91 999";
      const edited = Papa.unparse({ fields: Object.keys(mine[0]!), data: mine });

      const again = await importCsv("teachers", edited);
      assert.deepEqual(
        { inserted: again.inserted, updated: (again as { updated?: number }).updated, errors: again.errors },
        { inserted: 0, updated: 2, errors: [] },
      );
      const { rows } = await c.query(`SELECT full_name, phone FROM teachers WHERE full_name LIKE $1 ORDER BY full_name`, [`% ${t}`]);
      assert.deepEqual(rows, [
        { full_name: `One ${t}`, phone: "+91 999" },
        { full_name: `Two ${t}`, phone: "+91 901" },
      ]);
    } finally {
      await f.cleanup();
    }
  });
});

test("an imported update obeys the same guard as the grid's edit", { skip }, async () => {
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("csv-upsert-lock");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const a = await f.row("teachers", { school_id: school, full_name: `A ${t}` });
      const b = await f.row("teachers", { school_id: school, full_name: `B ${t}` });
      const observer = await f.user("observer", "observer");
      const cycle = await f.row("observation_cycles", {
        code: `OBS-${t}`,
        teacher_id: a,
        observer_id: observer,
        kind: "evaluative",
        status: "complete",
        scheduled_at: new Date("2026-10-01T04:30:00Z"),
      });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const r = await importCsv(
        "observation-cycles",
        `id,code,teacherId,observerId,kind,scheduledAt\n${cycle},OBS-${t},${b},${observer},evaluative,2026-10-01T04:30:00Z\n`,
      );
      assert.equal(r.errors[0]?.row, 2, JSON.stringify(r));
      assert.match(r.errors[0]?.message ?? "", /teacher/i);
      const { rows: [row] } = await c.query(`SELECT teacher_id FROM observation_cycles WHERE id = $1`, [cycle]);
      assert.equal(row.teacher_id, a);
    } finally {
      await f.cleanup();
    }
  });
});

// ── WHAT AN UPDATE WRITES ────────────────────────────────────────────────────
//
// The first version of the update wrote the whole zod result, which includes
// the schema's `.default()` values for every column the file does not carry.
// Neither export carries every form field, so the round trip itself reset
// data: the mentors export (its own route, no `active` column) re-activated a
// deactivated mentor, and the course-outlines export (no sessionsCount or
// learningOutcomes) zeroed the session count and emptied the outcomes -- each
// reported as ok:true, updated:1. An update sets the columns the file
// carries, and nothing else.

async function place(f: ReturnType<typeof fixture>, t: string) {
  const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  return f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
}

test("re-importing the mentors export leaves what it does not carry alone", { skip }, async () => {
  const { GET } = await import("../../apps/web/src/app/api/admin/data/mentors/export/route.ts");
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("csv-upsert-mentors");
    const f = fixture(c, t);
    try {
      const mentor = await f.row("mentors", {
        name: `Mentor ${t}`,
        bio: "Twenty years in Leh",
        active: false,
        expertise_areas: JSON.stringify(["phonics", "numeracy"]),
      });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const res = await GET(new Request("http://x/api/admin/data/mentors/export"));
      const exported = Papa.parse(await res.text(), { header: true, skipEmptyLines: true });
      const mine = exported.data.filter((r) => r.id === mentor);
      assert.equal(mine.length, 1);
      mine[0]!.name = `Renamed ${t}`;

      const r = await importCsv("mentors", Papa.unparse({ fields: Object.keys(mine[0]!), data: mine }));
      assert.deepEqual({ updated: r.updated, inserted: r.inserted, errors: r.errors }, { updated: 1, inserted: 0, errors: [] });
      const { rows: [row] } = await c.query(`SELECT name, active, bio, expertise_areas FROM mentors WHERE id = $1`, [mentor]);
      assert.equal(row.name, `Renamed ${t}`, "the edited cell is written");
      assert.equal(row.active, false, "re-importing the export re-activated a deactivated mentor");
      assert.equal(row.bio, "Twenty years in Leh");
      assert.deepEqual(row.expertise_areas, ["phonics", "numeracy"]);
    } finally {
      await f.cleanup();
    }
  });
});

test("re-importing the course-outlines export keeps the session count and outcomes", { skip }, async () => {
  const { GET } = await import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("csv-upsert-outlines");
    const f = fixture(c, t);
    try {
      const subject = await f.row("subjects", { name: `Subject ${t}`, code: t.slice(-12) });
      const outline = await f.row("course_outlines", {
        subject_id: subject,
        grade: 3,
        term: 1,
        name: `Outline ${t}`,
        sessions_count: 12,
        status: "in_progress",
        learning_outcomes: JSON.stringify(["read", "write"]),
      });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const res = await GET(new Request("http://x/api/admin/data/course-outlines/export"), {
        params: Promise.resolve({ entity: "course-outlines" }),
      });
      const exported = Papa.parse(await res.text(), { header: true, skipEmptyLines: true });
      const mine = exported.data.filter((r) => r.id === outline);
      assert.equal(mine.length, 1);
      mine[0]!.weeks = "10";

      const r = await importCsv("course-outlines", Papa.unparse({ fields: Object.keys(mine[0]!), data: mine }));
      assert.deepEqual({ updated: r.updated, errors: r.errors }, { updated: 1, errors: [] });
      const { rows: [row] } = await c.query(
        `SELECT weeks, sessions_count, learning_outcomes, status FROM course_outlines WHERE id = $1`,
        [outline],
      );
      assert.equal(row.weeks, 10);
      assert.equal(row.sessions_count, 12, "sessions_count was reset to its zod default");
      assert.deepEqual(row.learning_outcomes, ["read", "write"], "learning_outcomes was emptied");
      assert.equal(row.status, "in_progress");
    } finally {
      await f.cleanup();
    }
  });
});

test("a file of ids and one column updates that column; an emptied cell clears it", { skip }, async () => {
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("csv-upsert-partial");
    const f = fixture(c, t);
    try {
      const school = await place(f, t);
      const a = await f.row("teachers", { school_id: school, full_name: `A ${t}`, phone: "+91 100", active: false });
      const b = await f.row("teachers", { school_id: school, full_name: `B ${t}`, phone: "+91 200", subject_specialism: "Maths" });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      // No fullName or schoolId (both required on a new row): an update of
      // an existing row does not need them.
      const r = await importCsv("teachers", `id,phone\n${a},+91 111\n${b},\n`);
      assert.deepEqual({ updated: r.updated, inserted: r.inserted, errors: r.errors }, { updated: 2, inserted: 0, errors: [] });
      const { rows } = await c.query(
        `SELECT full_name, phone, active, subject_specialism, school_id FROM teachers WHERE id IN ($1, $2) ORDER BY full_name`,
        [a, b],
      );
      assert.deepEqual(rows, [
        { full_name: `A ${t}`, phone: "+91 111", active: false, subject_specialism: null, school_id: school },
        { full_name: `B ${t}`, phone: null, active: true, subject_specialism: "Maths", school_id: school },
      ]);
    } finally {
      await f.cleanup();
    }
  });
});
