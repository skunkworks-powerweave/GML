// Importing the same CSV twice adds its rows once.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// After an import the panel kept the file and its "Import N rows" button live
// (admin-csv-import-panel.test.ts: the panel now clears them), so the natural
// second click sent the same rows again. The question this answers is what the
// server does with them: nothing may be added a second time, and the operator
// has to be told why, row by row, rather than see a result that looks like
// success. (Found in the 5 Oct 2026 QA of the admin flows.)
//
// ── WHAT IS EXECUTED ───────────────────────────────────────────────────────
//
// The real importCsv, as a super_admin, against Postgres, for the tables an
// onboarding sheet is made of -- zones, schools, classes, teachers, mentors,
// students, subjects, districts and student attendance -- each linked by the
// names a spreadsheet would hold. The first import adds the rows; the same file
// again adds none, leaves the counts as they were and reports every row as
// already there. Rows that hold an id (an export) are updated in place rather
// than copied.
//
// Which tables are protected is each entity's own definition: a duplicateKey
// where the data has no natural unique value (people, rosters), the database's
// unique index where it has one (a school's code, a class's grade). Tables with
// neither (RTT sessions, modules, lessons and readings, classroom sessions,
// resources, tests) are not covered here: nothing in their rows says "the same
// record", so an id-less file for them can still be added twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, type Fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const csvModule = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");

const count = async (f: Fixture, sql: string, params: unknown[]): Promise<number> => (await f.c.query(sql, params)).rows[0].n as number;

type Imported = Awaited<ReturnType<Awaited<ReturnType<typeof csvModule>>["importCsv"]>>;

/** The same file twice: what each import reported. */
async function twice(entity: string, csv: string): Promise<{ first: Imported; second: Imported }> {
  const { importCsv } = await csvModule();
  const first = await importCsv(entity, csv);
  const second = await importCsv(entity, csv);
  return { first, second };
}

function assertReportedAsExisting(entity: string, rows: number, second: Imported) {
  assert.equal(second.inserted, 0, `${entity}: the second import added rows: ${JSON.stringify(second)}`);
  assert.equal(second.updated, 0, `${entity}: the second import changed rows`);
  assert.equal(second.ok, false, `${entity}: the second import reported success`);
  assert.equal(second.errors.length, rows, `${entity}: every row of the file is reported: ${JSON.stringify(second.errors)}`);
  for (const e of second.errors) assert.match(e.message, /already/i, `${entity} line ${e.row}: "${e.message}" does not say the row exists`);
  assert.deepEqual(
    second.errors.map((e) => e.row),
    Array.from({ length: rows }, (_, i) => i + 2),
    `${entity}: each is reported against its spreadsheet line`,
  );
}

test("an onboarding sheet imported twice is added once, and the second time says every row is already there", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("twice");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `Dist ${t}`, code: t.slice(-12) });
      const zoneName = `Zone A ${t}`;
      f.defer(`DELETE FROM zones WHERE district_id = $1`, [district]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      // zones
      const zones = await twice("zones", [`name,districtId`, `${zoneName},Dist ${t}`, `Zone B ${t},Dist ${t}`].join("\n"));
      assert.equal(zones.first.inserted, 2, JSON.stringify(zones.first));
      assertReportedAsExisting("zones", 2, zones.second);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM zones WHERE district_id = $1`, [district]), 2);

      // schools, named into their zone
      const code = (n: string) => `${t.slice(-9)}${n}`;
      f.defer(`DELETE FROM schools WHERE code LIKE $1`, [`${t.slice(-9)}%`]);
      const zoneId = (await c.query(`SELECT id FROM zones WHERE district_id = $1 AND name = $2`, [district, zoneName])).rows[0].id as string;
      const schools = await twice("schools", [`name,code,zoneId`, `Hill ${t},${code("a")},${zoneName}`, `Dale ${t},${code("b")},${zoneName}`].join("\n"));
      assert.equal(schools.first.inserted, 2, JSON.stringify(schools.first));
      assertReportedAsExisting("schools", 2, schools.second);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM schools WHERE zone_id = $1`, [zoneId]), 2);
      const hill = (await c.query(`SELECT id FROM schools WHERE code = $1`, [code("a")])).rows[0].id as string;

      // classes, named into their school
      f.defer(`DELETE FROM classes WHERE school_id = $1`, [hill]);
      const classes = await twice("classes", [`schoolId,grade,stage`, `Hill ${t},4,primary`, `Hill ${t},5,primary`].join("\n"));
      assert.equal(classes.first.inserted, 2, JSON.stringify(classes.first));
      assertReportedAsExisting("classes", 2, classes.second);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM classes WHERE school_id = $1`, [hill]), 2);

      // teachers: no unique value in the data, so the entity's duplicateKey is what stops the copy
      f.defer(`DELETE FROM teachers WHERE school_id = $1`, [hill]);
      const teachers = await twice(
        "teachers",
        [`fullName,schoolId,phone`, `Tsering Dolma ${t},Hill ${t},9000000001`, `Stanzin Norbu ${t},Hill ${t},9000000002`].join("\n"),
      );
      assert.equal(teachers.first.inserted, 2, JSON.stringify(teachers.first));
      assertReportedAsExisting("teachers", 2, teachers.second);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM teachers WHERE school_id = $1`, [hill]), 2);

      // mentors
      f.defer(`DELETE FROM mentors WHERE name LIKE $1`, [`% ${t}`]);
      const mentors = await twice("mentors", [`name,bio`, `Padma Lhamo ${t},Phonics`, `Rigzin Angmo ${t},Numeracy`].join("\n"));
      assert.equal(mentors.first.inserted, 2, JSON.stringify(mentors.first));
      assertReportedAsExisting("mentors", 2, mentors.second);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM mentors WHERE name LIKE $1`, [`% ${t}`]), 2);

      // students, named into their class
      f.defer(`DELETE FROM learners WHERE school_id = $1`, [hill]);
      const students = await twice(
        "learners",
        [
          `classId,schoolId,grade,name,rollNumber`,
          `Hill ${t} · Grade 4,Hill ${t},4,Asha ${t},1`,
          `Hill ${t} · Grade 4,Hill ${t},4,Bela ${t},2`,
        ].join("\n"),
      );
      assert.equal(students.first.inserted, 2, JSON.stringify(students.first));
      assertReportedAsExisting("learners", 2, students.second);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM learners WHERE school_id = $1`, [hill]), 2);

      // subjects and districts: the other geography and curriculum lists
      f.defer(`DELETE FROM subjects WHERE name LIKE $1`, [`Subj % ${t}`]);
      const subjects = await twice(
        "subjects",
        [`name,code`, `Subj A ${t},SA${t.slice(-6).toUpperCase()}`, `Subj B ${t},SB${t.slice(-6).toUpperCase()}`].join("\n"),
      );
      assert.equal(subjects.first.inserted, 2, JSON.stringify(subjects.first));
      assertReportedAsExisting("subjects", 2, subjects.second);
      f.defer(`DELETE FROM districts WHERE name LIKE $1`, [`Dist X% ${t}`]);
      const districts = await twice("districts", [`name,code`, `Dist X1 ${t},${t.slice(-9)}X1`, `Dist X2 ${t},${t.slice(-9)}X2`].join("\n"));
      assert.equal(districts.first.inserted, 2, JSON.stringify(districts.first));
      assertReportedAsExisting("districts", 2, districts.second);

      // a student's attendance, named by the session and the student
      const klass = (await c.query(`SELECT id FROM classes WHERE school_id = $1 AND grade = 4`, [hill])).rows[0].id as string;
      const subject = (await c.query(`SELECT id FROM subjects WHERE name = $1`, [`Subj A ${t}`])).rows[0].id as string;
      const teacher = (await c.query(`SELECT id FROM teachers WHERE school_id = $1 LIMIT 1`, [hill])).rows[0].id as string;
      const session = await f.row("sessions", {
        school_id: hill,
        class_id: klass,
        subject_id: subject,
        teacher_id: teacher,
        scheduled_date: "2026-10-05",
        topic: `Fractions ${t}`,
      });
      f.defer(`DELETE FROM session_attendance WHERE session_id = $1`, [session]);
      const attendance = await twice(
        "session-attendance",
        [`sessionId,learnerId,status`, `2026-10-05 · Fractions ${t},Asha ${t} #1,present`, `2026-10-05 · Fractions ${t},Bela ${t} #2,absent`].join("\n"),
      );
      assert.equal(attendance.first.inserted, 2, JSON.stringify(attendance.first));
      assertReportedAsExisting("session-attendance", 2, attendance.second);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM session_attendance WHERE session_id = $1`, [session]), 2);
    } finally {
      await f.cleanup();
    }
  });
});

test("an export imported straight back changes nothing and copies nothing", { skip }, async () => {
  const { importCsv } = await csvModule();
  const { GET } = await import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
  await withClient(async (c) => {
    const t = tag("twice-ids");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `Dist ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Zone ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `Hill ${t}`, code: t.slice(-12) });
      f.defer(`DELETE FROM teachers WHERE school_id = $1`, [school]);
      await f.row("teachers", { school_id: school, full_name: `Tsering Dolma ${t}`, phone: "9000000001" });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const res = await GET(new Request("http://x/api/admin/data/teachers/export"), { params: Promise.resolve({ entity: "teachers" }) });
      const lines = (await res.text()).split(/\r?\n/);
      const mine = [lines[0]!, ...lines.slice(1).filter((l) => l.includes(`Tsering Dolma ${t}`))].join("\n");
      for (let round = 0; round < 2; round += 1) {
        const r = await importCsv("teachers", mine);
        assert.deepEqual({ inserted: r.inserted, errors: r.errors }, { inserted: 0, errors: [] }, `round ${round}`);
      }
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM teachers WHERE school_id = $1`, [school]), 1);
    } finally {
      await f.cleanup();
    }
  });
});
