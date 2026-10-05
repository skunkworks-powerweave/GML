// A school with a teacher, her classes, her students and a session, COMMITTED,
// for the tests that execute the /teaching server actions, pages and routes
// (attendance roster, attendance CSV, students CSV). Everything a test makes
// is removed again by `f.cleanup()`; audit_log is append-only and is left.
//
//   school S          teacher T (section A of Grade 5, and the whole of Grade 6)
//                     colleague O (Grade 6), who has a session of her own
//   Grade 5 students  Angmo 1 / A, Bilal 2 / A, Chosdol 3 / A, Deskit 4 / B
//                     (not on T's roster: she teaches section A), and two
//                     children called Tashi (5 and 6, both section A)
//   Grade 7           a class of S that T is NOT linked to
//   other school      a Grade 5 class T is not linked to either

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { fixture, form, type Fixture } from "./_admin-fixture.js";
import { signIn } from "./_server-actions.js";
import { tag } from "./_harness.js";

export type TeachingWorld = Awaited<ReturnType<typeof teachingWorld>>;

export async function teachingWorld(c: Client, prefix = "tw") {
  const t = tag(prefix);
  const f: Fixture = fixture(c, t);
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: `S${code}`.slice(0, 16) });
  const otherSchool = await f.row("schools", { zone_id: zone, name: `Other school ${t}`, code: `O${code}`.slice(0, 16) });
  const maths = await f.row("subjects", { name: `Maths ${t}`, code: `M${code}`.slice(0, 16) });

  const teacherUser = await f.user("teacher", "t1");
  const otherUser = await f.user("teacher", "t2");
  const padmin = await f.user("programme_admin", "pa");
  const mentor = await f.user("mentor", "m");
  const observer = await f.user("observer", "ob");
  const teacher = await f.row("teachers", { school_id: school, full_name: `Teacher ${t}`, user_id: teacherUser });
  const other = await f.row("teachers", { school_id: school, full_name: `Other ${t}`, user_id: otherUser });

  const five = await f.row("classes", { school_id: school, grade: 5, stage: "Primary" });
  const six = await f.row("classes", { school_id: school, grade: 6, stage: "Middle" });
  const seven = await f.row("classes", { school_id: school, grade: 7, stage: "Middle" });
  const otherFive = await f.row("classes", { school_id: otherSchool, grade: 5, stage: "Primary" });
  const link = await f.row("teacher_classes", { teacher_id: teacher, class_id: five, section: "A", subject_id: maths });
  const sixLink = await f.row("teacher_classes", { teacher_id: teacher, class_id: six });
  const otherLink = await f.row("teacher_classes", { teacher_id: other, class_id: six });

  const learner = (name: string, roll: string | null, section: string | null, classId = five) =>
    f.row("learners", { class_id: classId, school_id: school, grade: 5, name, roll_number: roll, section });
  const angmo = await learner("Angmo", "1", "A");
  const bilal = await learner("Bilal", "2", "A");
  const chosdol = await learner("Chosdol", "3", "A");
  const deskit = await learner("Deskit", "4", "B");
  const tashi5 = await learner("Tashi", "5", "A");
  const tashi6 = await learner("Tashi", "6", "A");

  // What the tests create, removed before the rows above (defers run last-registered first).
  f.defer(`DELETE FROM classes WHERE school_id = ANY($1)`, [[school, otherSchool]]);
  f.defer(`DELETE FROM learners WHERE school_id = ANY($1)`, [[school, otherSchool]]);
  f.defer(`DELETE FROM teacher_classes WHERE teacher_id = ANY($1)`, [[teacher, other]]);
  f.defer(`DELETE FROM sessions WHERE teacher_id = ANY($1)`, [[teacher, other]]);
  f.defer(`DELETE FROM session_attendance WHERE session_id IN (SELECT id FROM sessions WHERE teacher_id = ANY($1))`, [[teacher, other]]);
  f.defer(`DELETE FROM approvals WHERE item_id IN (SELECT id FROM sessions WHERE teacher_id = ANY($1))`, [[teacher, other]]);

  /** A session of `teacherId` for `classId` (section A of Grade 5 unless said), a draft. */
  const session = (extra: Record<string, unknown> = {}) =>
    f.row("sessions", {
      school_id: school,
      class_id: five,
      section: "A",
      subject_id: maths,
      teacher_id: teacher,
      scheduled_date: "2026-10-05",
      topic: `Fractions ${t}`,
      status: "planned",
      approval_status: "draft",
      ...extra,
    });

  return {
    t,
    f,
    c,
    school,
    otherSchool,
    maths,
    teacherUser,
    otherUser,
    padmin,
    mentor,
    observer,
    teacher,
    other,
    five,
    six,
    seven,
    otherFive,
    link,
    sixLink,
    otherLink,
    angmo,
    bilal,
    chosdol,
    deskit,
    tashi5,
    tashi6,
    session,
    /** Her roster, by name: the ids the session's section A shows. */
    roster: { angmo, bilal, chosdol, tashi5, tashi6 },
  };
}

export const as = (id: string, role: string): void => signIn({ id, role, name: null, email: null });

/** A FormData with a CSV attached as the file field `file`, as a browser posts it. */
export function csvForm(csv: string, fields: Record<string, string> = {}, name = "upload.csv"): FormData {
  const fd = form(fields);
  fd.set("file", new File([csv], name, { type: "text/csv" }));
  return fd;
}

/** What each student of a session is marked, by learner id. */
export async function marksOf(c: Client, sessionId: string): Promise<Record<string, string>> {
  const { rows } = await c.query(`SELECT learner_id, status FROM session_attendance WHERE session_id = $1`, [sessionId]);
  return Object.fromEntries(rows.map((r) => [r.learner_id as string, r.status as string]));
}

export async function countsOf(c: Client, sessionId: string) {
  return (await c.query(`SELECT attended_count, total_count FROM sessions WHERE id = $1`, [sessionId])).rows[0] as {
    attended_count: number;
    total_count: number;
  };
}

const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");

/**
 * The metadata keys of an audit row against docs/audit-actions.md, both ways:
 * none written and undocumented, none documented and not written. An operator
 * queries audit_log by what that file says.
 */
export function assertDocumented(action: string, row: { entity_type?: string; metadata: Record<string, unknown> }): void {
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${action}\` |`));
  assert.ok(line, `${action} is written and missing from docs/audit-actions.md`);
  const documented = new Set([...line.split("|")[3]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!));
  for (const k of Object.keys(row.metadata)) assert.ok(documented.has(k), `${action}: \`${k}\` is written and not documented`);
  for (const k of documented) assert.ok(k in row.metadata, `${action}: documented \`${k}\` is not written`);
  if (row.entity_type) assert.ok(line.includes(`\`${row.entity_type}\``), `${action}: entity_type ${row.entity_type} is not documented`);
}
