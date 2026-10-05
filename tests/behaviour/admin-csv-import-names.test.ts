// A CSV can name the record a row links to, not only give its id.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// Every link in an import file (a zone's districtId, a school's zoneId, a
// teacher's schoolId, a student's classId, an attendance row's sessionId and
// learnerId) had to be a UUID. A spreadsheet with "Leh" or "GMS Drass" in the
// column was rejected row by row with "Invalid uuid", and the only way to get
// the ids was to export the parent table and copy them in by hand. The forms
// pick the same links by name from a drop-down. (Found in the 5 Oct 2026 QA of
// the admin flows.)
//
// ── WHAT IS EXECUTED ───────────────────────────────────────────────────────
//
// The real importCsv, as a super_admin, against Postgres. A linked column takes
// the name the form's drop-down shows (case and spacing do not matter), or an
// id. A name that matches nothing, or more than one record, is a clear error
// on its own line, and the other rows still land.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, type Fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const csvModule = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");

async function geography(f: Fixture, t: string) {
  const district = await f.row("districts", { name: `Dist ${t}`, code: t.slice(-12) });
  const zone = await f.row("zones", { district_id: district, name: `Zone ${t}` });
  return { district, zone, districtName: `Dist ${t}`, zoneName: `Zone ${t}` };
}

const count = async (f: Fixture, sql: string, params: unknown[]): Promise<number> =>
  (await f.c.query(sql, params)).rows[0].n as number;

test("zones and schools are imported with the district and zone named, in any case and spacing", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("names-geo");
    const f = fixture(c, t);
    try {
      const g = await geography(f, t);
      f.defer(`DELETE FROM schools WHERE code LIKE $1`, [`${t.slice(-8)}%`]);
      f.defer(`DELETE FROM zones WHERE name LIKE $1`, [`ZN% ${t}`]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const z = await importCsv(
        "zones",
        [
          "name,districtId",
          `ZN1 ${t},${g.districtName}`,
          `ZN2 ${t},  ${g.districtName.toUpperCase()}  `, // case and spaces do not matter
          `ZN3 ${t},${g.district}`, // an id still works
        ].join("\n"),
      );
      assert.equal(z.inserted, 3, JSON.stringify(z));
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM zones WHERE district_id = $1 AND name LIKE 'ZN% ${t}'`, [g.district]), 3);

      const s = await importCsv(
        "schools",
        ["name,code,zoneId", `School A ${t},${t.slice(-8)}a,${g.zoneName}`, `School B ${t},${t.slice(-8)}b,${g.zone}`].join("\n"),
      );
      assert.equal(s.inserted, 2, JSON.stringify(s));
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM schools WHERE zone_id = $1`, [g.zone]), 2);
    } finally {
      await f.cleanup();
    }
  });
});

test("a school is named by its drop-down label, by its name, or by its code", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("names-school");
    const f = fixture(c, t);
    try {
      const g = await geography(f, t);
      const code = t.slice(-12);
      const school = await f.row("schools", { zone_id: g.zone, name: `Hill School ${t}`, code });
      f.defer(`DELETE FROM teachers WHERE full_name LIKE $1`, [`% ${t}`]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const r = await importCsv(
        "teachers",
        [
          "fullName,schoolId",
          `By label ${t},Hill School ${t} (${code})`,
          `By name ${t},hill school ${t}`,
          `By code ${t},${code.toUpperCase()}`,
        ].join("\n"),
      );
      assert.equal(r.inserted, 3, JSON.stringify(r));
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM teachers WHERE school_id = $1 AND full_name LIKE $2`, [school, `% ${t}`]), 3);
    } finally {
      await f.cleanup();
    }
  });
});

test("a name that matches nothing, or two records, is reported on its own line and the rest still land", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("names-bad");
    const f = fixture(c, t);
    try {
      const g = await geography(f, t);
      const zone2 = await f.row("zones", { district_id: g.district, name: `Zone Two ${t}` });
      await f.row("schools", { zone_id: g.zone, name: `Twin ${t}`, code: `${t.slice(-10)}a` });
      await f.row("schools", { zone_id: zone2, name: `Twin ${t}`, code: `${t.slice(-10)}b` });
      const solo = await f.row("schools", { zone_id: g.zone, name: `Solo ${t}`, code: `${t.slice(-10)}c` });
      f.defer(`DELETE FROM teachers WHERE full_name LIKE $1`, [`% ${t}`]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const r = await importCsv(
        "teachers",
        [
          "fullName,schoolId",
          `Good ${t},Solo ${t}`, // line 2
          `Nowhere ${t},No such school ${t}`, // line 3
          `Either ${t},Twin ${t}`, // line 4: two schools
          `Exact ${t},Twin ${t} (${t.slice(-10)}b)`, // line 5: the label tells them apart
        ].join("\n"),
      );
      assert.equal(r.inserted, 2, JSON.stringify(r));
      assert.deepEqual(r.errors.map((e) => e.row), [3, 4], JSON.stringify(r.errors));
      const [notFound, ambiguous] = r.errors.map((e) => e.message);
      assert.match(notFound!, /schoolId/);
      assert.match(notFound!, new RegExp(`No such school ${t}`));
      assert.match(ambiguous!, /schoolId/);
      assert.match(ambiguous!, /2 records/);
      assert.match(ambiguous!, new RegExp(`Twin ${t} \\(${t.slice(-10)}a\\)`), "both candidates are named so the operator can pick");
      assert.match(ambiguous!, new RegExp(`Twin ${t} \\(${t.slice(-10)}b\\)`));
      assert.doesNotMatch(`${notFound}${ambiguous}`, /Invalid uuid/);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM teachers WHERE school_id = $1`, [solo]), 1);
    } finally {
      await f.cleanup();
    }
  });
});

test("classes, students and attendance link by the names the grid shows", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("names-chain");
    const f = fixture(c, t);
    try {
      const g = await geography(f, t);
      const school = await f.row("schools", { zone_id: g.zone, name: `Valley ${t}`, code: t.slice(-12) });
      const subject = await f.row("subjects", { name: `Subj ${t}`, code: `S${t.slice(-6).toUpperCase()}` });
      const teacher = await f.row("teachers", { school_id: school, full_name: `Tea ${t}` });
      // Cleanup runs in reverse: attendance, then learners, then classes.
      f.defer(`DELETE FROM classes WHERE school_id = $1`, [school]);
      f.defer(`DELETE FROM learners WHERE school_id = $1`, [school]);
      f.defer(`DELETE FROM session_attendance WHERE learner_id IN (SELECT id FROM learners WHERE school_id = $1)`, [school]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const cls = await importCsv("classes", ["schoolId,grade,stage", `Valley ${t},5,primary`].join("\n"));
      assert.equal(cls.inserted, 1, JSON.stringify(cls));
      const klass = (await c.query(`SELECT id FROM classes WHERE school_id = $1`, [school])).rows[0].id as string;

      const stu = await importCsv(
        "learners",
        [
          "classId,schoolId,grade,name,rollNumber",
          `Valley ${t} · Grade 5,Valley ${t},5,Asha ${t},12`,
          `Valley ${t} · Grade 5,Valley ${t},5,Bela ${t},13`,
        ].join("\n"),
      );
      assert.equal(stu.inserted, 2, JSON.stringify(stu));
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM learners WHERE class_id = $1`, [klass]), 2);

      const session = await f.row("sessions", {
        school_id: school,
        class_id: klass,
        subject_id: subject,
        teacher_id: teacher,
        scheduled_date: "2026-10-05",
        topic: `Fractions ${t}`,
      });
      const att = await importCsv(
        "session-attendance",
        [
          "sessionId,learnerId,status",
          `2026-10-05 · Fractions ${t},Asha ${t} #12,present`,
          `2026-10-05 · Fractions ${t},Bela ${t} #13,absent`,
        ].join("\n"),
      );
      assert.equal(att.inserted, 2, JSON.stringify(att));
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM session_attendance WHERE session_id = $1`, [session]), 2);
    } finally {
      await f.cleanup();
    }
  });
});

test("a login is named by its email, and a column may be written without the Id suffix", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("names-alias");
    const f = fixture(c, t);
    try {
      const g = await geography(f, t);
      const school = await f.row("schools", { zone_id: g.zone, name: `Alias ${t}`, code: t.slice(-12) });
      const login = await f.user("teacher", "tch");
      f.defer(`DELETE FROM teachers WHERE school_id = $1`, [school]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const r = await importCsv(
        "teachers",
        ["fullName,school,userId", `Linked ${t},Alias ${t},tch.${t}@example.test`].join("\n"),
      );
      assert.equal(r.inserted, 1, JSON.stringify(r));
      const row = (await c.query(`SELECT school_id, user_id FROM teachers WHERE school_id = $1`, [school])).rows[0];
      assert.equal(row.school_id, school, "the `school` column is the schoolId column");
      assert.equal(row.user_id, login, "the account was found by its email address");
    } finally {
      await f.cleanup();
    }
  });
});

test("a gated link is never turned into an id for someone who has not unlocked the gate", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("names-gate");
    const f = fixture(c, t);
    try {
      const g = await geography(f, t);
      const school = await f.row("schools", { zone_id: g.zone, name: `Gate ${t}`, code: t.slice(-12) });
      const subject = await f.row("subjects", { name: `Subj ${t}`, code: `S${t.slice(-6).toUpperCase()}` });
      const klass = await f.row("classes", { school_id: school, grade: 5, stage: "Primary" });
      const teacher = await f.row("teachers", { school_id: school, full_name: `Tea ${t}` });
      const observer = await f.user("observer", "obs");
      await f.row("observation_cycles", {
        code: `CYC-${t}`,
        teacher_id: teacher,
        observer_id: observer,
        kind: "baseline",
        scheduled_at: new Date("2026-10-01T04:30:00Z"),
      });
      f.defer(`DELETE FROM sessions WHERE school_id = $1`, [school]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const r = await importCsv(
        "sessions",
        [
          "schoolId,classId,subjectId,teacherId,scheduledDate,observationCycleId",
          `Gate ${t},Gate ${t} · Grade 5,Subj ${t},Tea ${t},2026-10-05,CYC-${t}`,
        ].join("\n"),
      );
      assert.equal(r.inserted, 0, "the cycle's code must not resolve without the Observation gate");
      assert.match(r.errors[0]?.message ?? "", /observationCycleId/);
      assert.equal(await count(f, `SELECT count(*)::int AS n FROM sessions WHERE class_id = $1`, [klass]), 0);
    } finally {
      await f.cleanup();
    }
  });
});
