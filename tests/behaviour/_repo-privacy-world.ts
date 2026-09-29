// Two teachers at one school, and everything each of them owns, COMMITTED for
// the repo-privacy-*.test.ts files: the /repo pages and /api/quickfind run on
// the app's own pool, which cannot see a test's open transaction. Every row is
// tagged and removed by `f.cleanup()`.
//
//   district D: zone Z1 with school S1, zone Z2 with school S2
//   S1: teacher A (a login, a phone) and teacher B (a login, a phone)
//       class K1 (grade 4, taught by A), class K2 (grade 6, taught by B),
//       class K4 (grade 7, A teaches section A only)
//   S2: class K3 (grade 5, nobody here teaches it)
//   learners: LA in K1, LB in K2, L4a (section A) and L4b (section B) in K4
//   subject SUB; sessions SA (A, K1, pending approval) and SB (B, K2)
//   outlines for SUB: P (programme, approved, grade 4) with one lesson both
//     sessions deliver, PD (programme, still a draft, grade 5), PA (A's plan,
//     pending, grade 4), PB (B's plan, approved, grade 6)
//   mentors: MA (a login) paired with A, MB paired with B
//   reading material R; RTT subjects: RW (programme-wide), RZ1 (zone Z1),
//     RZ2 (zone Z2)
//   logins: teacher A, teacher B, a teacher with no teachers row, a programme
//     admin, and MA's mentor login
//
// The tag T is in every name, topic and code, so one search for T matches
// every row an unscoped query would return.

import { randomInt } from "node:crypto";
import type { Client } from "pg";
import { fixture, type Fixture } from "./_admin-fixture.js";
import { tag } from "./_harness.js";

export type PrivacyWorld = {
  T: string;
  f: Fixture;
  users: { teacherA: string; teacherB: string; noRow: string; admin: string; mentor: string };
  teacherA: string;
  teacherB: string;
  phoneA: string;
  phoneB: string;
  schoolS1: string;
  schoolS2: string;
  classK1: string;
  classK2: string;
  classK3: string;
  classK4: string;
  subject: string;
  sessionA: string;
  sessionB: string;
  topicA: string;
  topicB: string;
  outlineP: string;
  outlinePD: string;
  planA: string;
  planB: string;
  mentorA: string;
  mentorB: string;
  resource: string;
  rttWide: string;
  rttZ1: string;
  rttZ2: string;
  names: {
    teacherA: string;
    teacherB: string;
    schoolS1: string;
    schoolS2: string;
    learnerA: string;
    learnerB: string;
    learner4a: string;
    learner4b: string;
    outlineP: string;
    outlinePD: string;
    planA: string;
    planB: string;
    mentorA: string;
    mentorB: string;
    classTeacherK1: string;
    classTeacherK2: string;
    resource: string;
    rttWide: string;
    rttZ1: string;
    rttZ2: string;
  };
};

export async function privacyWorld(c: Client, prefix = "rprv"): Promise<PrivacyWorld> {
  const T = tag(prefix);
  const f = fixture(c, T);
  const code = T.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const names = {
    teacherA: `Teacher A ${T}`,
    teacherB: `Teacher B ${T}`,
    schoolS1: `School One ${T}`,
    schoolS2: `School Two ${T}`,
    learnerA: `Learner A ${T}`,
    learnerB: `Learner B ${T}`,
    learner4a: `Learner 4a ${T}`,
    learner4b: `Learner 4b ${T}`,
    outlineP: `Programme outline ${T}`,
    outlinePD: `Draft programme outline ${T}`,
    planA: `Plan A ${T}`,
    planB: `Plan B ${T}`,
    mentorA: `Mentor A ${T}`,
    mentorB: `Mentor B ${T}`,
    classTeacherK1: `Form tutor one ${T}`,
    classTeacherK2: `Form tutor two ${T}`,
    resource: `Reading ${T}`,
    rttWide: `RTT wide ${T}`,
    rttZ1: `RTT zone one ${T}`,
    rttZ2: `RTT zone two ${T}`,
  };
  const phoneA = `+91 7${String(randomInt(1e8, 1e9))}`;
  const phoneB = `+91 8${String(randomInt(1e8, 1e9))}`;

  const district = await f.row("districts", { name: `District ${T}`, code: `D${code}` });
  const zone1 = await f.row("zones", { district_id: district, name: `Zone one ${T}` });
  const zone2 = await f.row("zones", { district_id: district, name: `Zone two ${T}` });
  const schoolS1 = await f.row("schools", { zone_id: zone1, name: names.schoolS1, code: `S1${code}`.slice(0, 16) });
  const schoolS2 = await f.row("schools", { zone_id: zone2, name: names.schoolS2, code: `S2${code}`.slice(0, 16) });

  const users = {
    teacherA: await f.user("teacher", "ta"),
    teacherB: await f.user("teacher", "tb"),
    noRow: await f.user("teacher", "tnorow"),
    admin: await f.user("programme_admin", "pa"),
    mentor: await f.user("mentor", "m"),
  };
  // Quick find's per-user throttle counters.
  f.defer(`DELETE FROM rate_limits WHERE key LIKE ANY($1)`, [Object.values(users).map((id) => `%:${id}`)]);

  const teacherA = await f.row("teachers", { school_id: schoolS1, full_name: names.teacherA, user_id: users.teacherA, phone: phoneA });
  const teacherB = await f.row("teachers", { school_id: schoolS1, full_name: names.teacherB, user_id: users.teacherB, phone: phoneB });

  const klass = (school: string, grade: number, classTeacherName: string | null) =>
    f.row("classes", { school_id: school, grade, stage: "Primary", students_count: 10, class_teacher_name: classTeacherName });
  const classK1 = await klass(schoolS1, 4, names.classTeacherK1);
  const classK2 = await klass(schoolS1, 6, names.classTeacherK2);
  const classK3 = await klass(schoolS2, 5, null);
  const classK4 = await klass(schoolS1, 7, null);
  await f.row("teacher_classes", { teacher_id: teacherA, class_id: classK1 });
  await f.row("teacher_classes", { teacher_id: teacherB, class_id: classK2 });
  await f.row("teacher_classes", { teacher_id: teacherA, class_id: classK4, section: "A" });

  const learner = (klassId: string, grade: number, name: string, section: string | null) =>
    f.row("learners", { class_id: klassId, school_id: schoolS1, grade, name, section });
  await learner(classK1, 4, names.learnerA, null);
  await learner(classK2, 6, names.learnerB, null);
  await learner(classK4, 7, names.learner4a, "A");
  await learner(classK4, 7, names.learner4b, "B");

  const subject = await f.row("subjects", { name: `Subject ${T}`, code: `SB${code}`.slice(0, 16), grades_min: 1, grades_max: 10 });

  const outline = (values: Record<string, unknown>) => f.row("course_outlines", { subject_id: subject, term: 1, ...values });
  const outlineP = await outline({ grade: 4, name: names.outlineP, approval_status: "approved" });
  const outlinePD = await outline({ grade: 5, name: names.outlinePD, approval_status: "draft" });
  const planA = await outline({ grade: 4, name: names.planA, owner_teacher_id: teacherA, approval_status: "pending" });
  const planB = await outline({ grade: 6, name: names.planB, owner_teacher_id: teacherB, approval_status: "approved" });
  const lesson = await f.row("outline_lessons", { outline_id: outlineP, sequence: 1, title: `Lesson ${T}` });

  const topicA = `Topic A ${T}`;
  const topicB = `Topic B ${T}`;
  const session = (teacher: string, klassId: string, topic: string, approval: string) =>
    f.row("sessions", {
      school_id: schoolS1,
      class_id: klassId,
      subject_id: subject,
      teacher_id: teacher,
      outline_lesson_id: lesson,
      scheduled_date: new Date().toISOString().slice(0, 10),
      topic,
      approval_status: approval,
    });
  const sessionA = await session(teacherA, classK1, topicA, "pending");
  const sessionB = await session(teacherB, classK2, topicB, "approved");

  const mentorA = await f.row("mentors", { user_id: users.mentor, name: names.mentorA, base_location: "Leh" });
  const mentorB = await f.row("mentors", { name: names.mentorB, base_location: "Kargil" });
  const pairing = (m: string, t: string) =>
    f.row("mentor_pairings", { mentor_id: m, teacher_id: t, status: "active", started_at: new Date(Date.now() - 30 * 864e5) });
  await pairing(mentorA, teacherA);
  await pairing(mentorB, teacherB);

  const resource = await f.row("resources", { name: names.resource, kind: "Guide", external_url: "https://example.test/r.pdf" });

  // phases.label is varchar(24) and unique; sequence is unique too.
  const phase = await f.row("phases", { label: `P ${T}`.slice(0, 24), sequence: 2_000_000 + randomInt(1_000_000_000) });
  const term = await f.row("terms", { phase_id: phase, name: `Term ${T}`, sequence: 1 });
  const rttWide = await f.row("rtt_subjects", { term_id: term, name: names.rttWide });
  const rttZ1 = await f.row("rtt_subjects", { term_id: term, name: names.rttZ1, zone_id: zone1 });
  const rttZ2 = await f.row("rtt_subjects", { term_id: term, name: names.rttZ2, zone_id: zone2 });

  return {
    T,
    f,
    users,
    teacherA,
    teacherB,
    phoneA,
    phoneB,
    schoolS1,
    schoolS2,
    classK1,
    classK2,
    classK3,
    classK4,
    subject,
    sessionA,
    sessionB,
    topicA,
    topicB,
    outlineP,
    outlinePD,
    planA,
    planB,
    mentorA,
    mentorB,
    resource,
    rttWide,
    rttZ1,
    rttZ2,
    names,
  };
}
