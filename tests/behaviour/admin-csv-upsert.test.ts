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

// ── A HAND-MADE ROSTER, UPLOADED AGAIN ───────────────────────────────────────
//
// The id round trip above only helps a file that carries ids, which an export
// does and a roster typed up in a spreadsheet does not. So the ordinary
// recovery from a partial import -- fix the three rejected rows, upload the
// whole file again -- inserted every row that had already landed a second
// time and reported ok:true: 17 teacher rows for 10 people, and the same for
// learners (children's records) and mentors. Nothing in those tables is
// unique without a login link. A row added without an id that matches one
// already on the table (a teacher: school + name, and phone when given; a
// learner: class + name, and roll number when given; a mentor: name) is now
// reported against its line, with the existing row's id, and not added.

test("re-uploading a hand-made roster after a partial failure adds only the rows that were missing", { skip }, async () => {
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("csv-roster-again");
    const f = fixture(c, t);
    try {
      const school = await place(f, t);
      const klass = await f.row("classes", { school_id: school, grade: 3, stage: "Primary" });
      f.defer(`DELETE FROM teachers WHERE full_name LIKE $1`, [`% ${t}`]);
      f.defer(`DELETE FROM learners WHERE name LIKE $1`, [`% ${t}`]);
      f.defer(`DELETE FROM mentors WHERE name LIKE $1`, [`% ${t}`]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const nowhere = "99999999-9999-4999-8999-999999999999";
      const count = async (sql: string) => (await c.query(sql, [`% ${t}`])).rows[0].n as number;

      // Teachers: 10 people, three of them typed with a school that does not exist.
      const roster = (schoolFor: (n: number) => string) =>
        "fullName,schoolId,phone\n" +
        Array.from({ length: 10 }, (_, i) => `Teacher${i + 1} ${t},${schoolFor(i + 1)},+91 90000 0000${i}`).join("\n") +
        "\n";
      const first = await importCsv("teachers", roster((n) => (n > 7 ? nowhere : school)));
      assert.deepEqual({ inserted: first.inserted, failed: first.errors.map((e) => e.row) }, { inserted: 7, failed: [9, 10, 11] });
      const again = await importCsv("teachers", roster(() => school));
      assert.equal(again.inserted, 3, JSON.stringify(again));
      assert.deepEqual(again.errors.map((e) => e.row), [2, 3, 4, 5, 6, 7, 8], "each row that had landed is reported");
      const { rows: [teacher1] } = await c.query(`SELECT id FROM teachers WHERE full_name = $1`, [`Teacher1 ${t}`]);
      assert.match(again.errors[0]!.message, new RegExp(`already.*${teacher1.id}`), "naming the row it matches");
      assert.equal(await count(`SELECT count(*)::int AS n FROM teachers WHERE full_name LIKE $1`), 10, "ten teachers, once each");

      // Learners: a roster with roll numbers, one grade mistyped.
      const learners = (grade3: number) =>
        `name,classId,schoolId,grade,rollNumber\n` +
        `Dolma ${t},${klass},${school},3,1\nPadma ${t},${klass},${school},3,2\nNamgyal ${t},${klass},${school},${grade3},3\n`;
      assert.equal((await importCsv("learners", learners(99))).inserted, 2);
      const learnersAgain = await importCsv("learners", learners(3));
      assert.deepEqual(
        { inserted: learnersAgain.inserted, reported: learnersAgain.errors.map((e) => e.row) },
        { inserted: 1, reported: [2, 3] },
      );
      assert.equal(await count(`SELECT count(*)::int AS n FROM learners WHERE name LIKE $1`), 3, "three children, once each");

      // Mentors: one name too short the first time.
      const mentors = (second: string) => `name,bio\nMentor One ${t},Leh\n${second},Kargil\n`;
      assert.equal((await importCsv("mentors", mentors("M"))).inserted, 1);
      const mentorsAgain = await importCsv("mentors", mentors(`Mentor Two ${t}`));
      assert.deepEqual(
        { inserted: mentorsAgain.inserted, reported: mentorsAgain.errors.map((e) => e.row) },
        { inserted: 1, reported: [2] },
      );
      assert.equal(await count(`SELECT count(*)::int AS n FROM mentors WHERE name LIKE $1`), 2);
    } finally {
      await f.cleanup();
    }
  });
});

test("a different person with the same name is still added, and a row repeated in one file is reported", { skip }, async () => {
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("csv-roster-same");
    const f = fixture(c, t);
    try {
      const school = await place(f, t);
      const klass = await f.row("classes", { school_id: school, grade: 4, stage: "Primary" });
      f.defer(`DELETE FROM teachers WHERE full_name LIKE $1`, [`% ${t}`]);
      f.defer(`DELETE FROM teachers WHERE full_name LIKE $1`, [`% ${t.toUpperCase()}`]);
      f.defer(`DELETE FROM learners WHERE name LIKE $1`, [`% ${t}`]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      await importCsv("teachers", `fullName,schoolId,phone\nTsering Dolma ${t},${school},+91 900\n`);
      // Same name, same school, a different phone: two people. Case and
      // surrounding spaces do not make a different person, though.
      const r = await importCsv(
        "teachers",
        `fullName,schoolId,phone\nTsering Dolma ${t},${school},+91 901\n  tsering dolma ${t.toUpperCase()} ,${school},+91 900\n`,
      );
      assert.deepEqual({ inserted: r.inserted, reported: r.errors.map((e) => e.row) }, { inserted: 1, reported: [3] });
      // A roster first uploaded without phones, then again with them: the
      // phone is compared only where both rows have one, so these are the
      // same people.
      await importCsv("teachers", `fullName,schoolId\nNorbu ${t},${school}\n`);
      const withPhones = await importCsv("teachers", `fullName,schoolId,phone\nNorbu ${t},${school},+91 902\n`);
      assert.deepEqual({ inserted: withPhones.inserted, reported: withPhones.errors.map((e) => e.row) }, { inserted: 0, reported: [2] });

      // The same child twice in one file: the second line is reported.
      const twice = await importCsv(
        "learners",
        `name,classId,schoolId,grade,rollNumber\nSonam ${t},${klass},${school},4,7\nSonam ${t},${klass},${school},4,7\nSonam ${t},${klass},${school},4,8\n`,
      );
      assert.deepEqual({ inserted: twice.inserted, reported: twice.errors.map((e) => e.row) }, { inserted: 2, reported: [3] });
      assert.match(twice.errors[0]!.message, /line 2/, "pointing at the line it repeats");
    } finally {
      await f.cleanup();
    }
  });
});
