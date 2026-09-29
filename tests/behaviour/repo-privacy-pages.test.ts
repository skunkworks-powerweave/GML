// In the Repository a teacher sees her own records only -- executed: every
// real /repo page, called as Next calls it and rendered, against Postgres.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The 2026-09-28 status review (docs/superpowers/specs/2026-09-28-teaching-
// records-design.md, "Privacy") found that any teacher could open
// /repo/teachers, click a colleague and read her phone number and every
// session she had taught; /repo/school/<id> listed every teacher of the school
// and their sessions; /repo/sessions, /repo/outlines and /repo/subject/<id>
// listed every teacher's sessions and lesson plans. The product owner's
// decision: in the Repository a teacher sees only her own records. Subjects,
// programme outlines and reading material stay shared; mentors, observers and
// administrators keep the programme-wide view.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// ./_repo-privacy-world.ts commits two teachers at one school with their
// classes, students, sessions, plans and mentors. Each page is called as
// teacher A, as teacher B's colleague would be, and must answer 404 for B's
// records and leave them out of every list; A's own must be there. The same
// pages are then called as an administrator and a mentor, who still see both.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { render, request, withAppRouter, decodeEntities } from "./_ui.js";
import { signIn, outcome, closeAppDb } from "./_server-actions.js";
import { needsDatabase, withClient } from "./_harness.js";
import { privacyWorld, type PrivacyWorld } from "./_repo-privacy-world.js";
import { phoneLayoutIssues, PHONE_WIDTH } from "./_phone-layout.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)/repo";

type Page = (props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;

const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

type Seen = { status: "404" } | { status: "redirect"; location: string } | { status: "ok"; html: string; text: string };

/** Call /repo/<file> as the signed-in user, and render what it returned. */
async function open(file: string, id = "", searchParams: Record<string, string> = {}): Promise<Seen> {
  const { default: page } = (await import(`${APP}/${file}`)) as { default: Page };
  const r = await outcome(() => page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(searchParams) }));
  if (r.kind === "notFound") return { status: "404" };
  if (r.kind === "redirect") return { status: "redirect", location: r.location };
  const html = await render(withAppRouter(r.value));
  return { status: "ok", html, text: text(html) };
}

/** The rendered page; fails when it was a 404 or a redirect. */
async function page(file: string, id = "", searchParams: Record<string, string> = {}): Promise<{ html: string; text: string }> {
  const seen = await open(file, id, searchParams);
  assert.equal(seen.status, "ok", `/repo/${file} (${id}) answered ${JSON.stringify(seen)}`);
  return seen as { html: string; text: string };
}

async function is404(file: string, id: string, what: string): Promise<void> {
  const seen = await open(file, id);
  assert.equal(seen.status, "404", `${what}: /repo/${file.replace("/page.tsx", "")} with ${id} was served (${seen.status})`);
}

function shows(out: string, shown: string[], hidden: string[], where: string): void {
  for (const s of shown) assert.ok(out.includes(s), `${where}: "${s}" should be shown`);
  for (const s of hidden) assert.ok(!out.includes(s), `${where}: "${s}" must not be shown`);
}

async function withWorld(body: (w: PrivacyWorld) => Promise<void>): Promise<void> {
  await withClient(async (c) => {
    const w = await privacyWorld(c);
    try {
      await body(w);
    } finally {
      signIn(null);
      await w.f.cleanup();
    }
  });
}

const as = (id: string, role: string) => signIn({ id, role });

test("a teacher's Repository shows her own records, and a colleague's answer 404 or are absent", { skip }, async () => {
  await withWorld(async (w) => {
    as(w.users.teacherA, "teacher");
    const n = w.names;

    // /repo/teachers -- herself; /repo/teacher/<id> -- her own profile only.
    shows((await page("teachers/page.tsx")).text, [n.teacherA], [n.teacherB], "/repo/teachers");
    shows((await page("teacher/[id]/page.tsx", w.teacherA)).text, [n.teacherA, w.phoneA, w.topicA], [w.phoneB, w.topicB], "/repo/teacher/A");
    await is404("teacher/[id]/page.tsx", w.teacherB, "a colleague's profile and phone");

    // /repo -- her own figures, and what they mean.
    const home = await page("page.tsx");
    assert.match(home.text, /Schools 1 .*Sessions 1 Teachers 1 Mentors 1 Learners 2 /, home.text.slice(0, 1500));
    assert.match(home.text, /Your own records/);
    shows(home.text, [], [w.topicB], "/repo");

    // Sessions: hers, labelled while they wait for approval.
    const sessions = await page("sessions/page.tsx");
    shows(sessions.text, [w.topicA, "Pending approval"], [w.topicB, n.teacherB], "/repo/sessions");
    shows((await page("session/[id]/page.tsx", w.sessionA)).text, [w.topicA, "Pending approval"], [], "/repo/session/A");
    await is404("session/[id]/page.tsx", w.sessionB, "a colleague's session");

    // Schools: hers, without its other teachers or their sessions.
    shows((await page("schools/page.tsx", "", { q: w.T })).text, [n.schoolS1], [n.schoolS2], "/repo/schools");
    const school = await page("school/[id]/page.tsx", w.schoolS1);
    shows(school.text, [n.teacherA, w.topicA], [n.teacherB, w.topicB], "/repo/school/S1");
    shows(school.html, [`/repo/class/${w.classK1}"`, `/repo/class/${w.classK4}"`], [`/repo/class/${w.classK2}"`], "/repo/school/S1 classes");
    await is404("school/[id]/page.tsx", w.schoolS2, "another school");

    // Classes: the ones she teaches, with her sessions and her roster.
    const k1 = await page("class/[id]/page.tsx", w.classK1);
    shows(k1.text, [w.topicA], [w.topicB], "/repo/class/K1");
    assert.ok(k1.html.includes(`/repo/class/${w.classK1}/learners`), "she may open her own class's roster");
    await page("class/[id]/page.tsx", w.classK4);
    await is404("class/[id]/page.tsx", w.classK2, "a colleague's class");
    await is404("class/[id]/page.tsx", w.classK3, "a class at another school");

    // Students: hers -- and in a class where she teaches one section, that section's.
    shows((await page("class/[id]/learners/page.tsx", w.classK1)).text, [n.learnerA], [n.learnerB], "/repo/class/K1/learners");
    shows((await page("class/[id]/learners/page.tsx", w.classK4)).text, [n.learner4a], [n.learner4b], "/repo/class/K4/learners");
    await is404("class/[id]/learners/page.tsx", w.classK2, "a colleague's class roster");
    shows(
      (await page("students/page.tsx", "", { q: w.T })).text,
      [n.learnerA, n.learner4a],
      [n.learnerB, n.learner4b],
      "/repo/students",
    );

    // Subjects are reference data; what hangs off one is hers.
    shows((await page("subjects/page.tsx", "", { q: w.T })).text, [`Subject ${w.T}`], [], "/repo/subjects");
    const subject = await page("subject/[id]/page.tsx", w.subject);
    shows(
      subject.text,
      [`Subject ${w.T}`, "Your sessions (1)", w.topicA, n.outlineP, n.planA],
      [w.topicB, n.teacherB, n.planB, n.outlinePD, "Distinct teachers with sessions on this subject"],
      "/repo/subject",
    );

    // Outlines: approved programme outlines and her own plans.
    shows((await page("outlines/page.tsx", "", { q: w.T })).text, [n.outlineP, n.planA], [n.planB, n.outlinePD], "/repo/outlines");
    shows((await page("outline/[id]/page.tsx", w.outlineP)).text, [n.outlineP, w.topicA], [w.topicB, n.teacherB], "/repo/outline/P");
    shows((await page("outline/[id]/page.tsx", w.planA)).text, [n.planA, "Pending approval"], [], "/repo/outline/planA");
    await is404("outline/[id]/page.tsx", w.planB, "a colleague's lesson plan");
    await is404("outline/[id]/page.tsx", w.outlinePD, "a programme outline not yet approved");

    // Mentors: her own.
    shows((await page("mentors/page.tsx", "", { q: w.T })).text, [n.mentorA], [n.mentorB], "/repo/mentors");
    await page("mentor/[id]/page.tsx", w.mentorA);
    await is404("mentor/[id]/page.tsx", w.mentorB, "a colleague's mentor");

    // Reading material is shared, as before.
    shows((await page("resources/page.tsx", "", { q: w.T })).text, [n.resource], [], "/repo/resources");
  });
});

test("administrators and mentors keep the programme-wide Repository", { skip }, async () => {
  await withWorld(async (w) => {
    const n = w.names;
    for (const [id, role] of [
      [w.users.admin, "programme_admin"],
      [w.users.mentor, "mentor"],
    ] as const) {
      as(id, role);
      shows((await page("teachers/page.tsx", "", { q: w.T })).text, [n.teacherA, n.teacherB], [], `${role} /repo/teachers`);
      shows((await page("teacher/[id]/page.tsx", w.teacherB)).text, [w.phoneB, w.topicB], [], `${role} /repo/teacher/B`);
      shows((await page("sessions/page.tsx", "", { q: w.T })).text, [w.topicA, w.topicB], [], `${role} /repo/sessions`);
      await page("session/[id]/page.tsx", w.sessionB);
      shows((await page("school/[id]/page.tsx", w.schoolS1)).text, [n.teacherA, n.teacherB, w.topicB], [], `${role} /repo/school`);
      await page("school/[id]/page.tsx", w.schoolS2);
      await page("class/[id]/page.tsx", w.classK2);
      shows(
        (await page("subject/[id]/page.tsx", w.subject)).text,
        [w.topicB, n.teacherB, n.planB, n.outlinePD, "Distinct teachers with sessions on this subject"],
        ["Your sessions"],
        `${role} /repo/subject`,
      );
      shows((await page("outlines/page.tsx", "", { q: w.T })).text, [n.planA, n.planB, n.outlinePD], [], `${role} /repo/outlines`);
      await page("outline/[id]/page.tsx", w.planB);
      shows((await page("mentors/page.tsx", "", { q: w.T })).text, [n.mentorA, n.mentorB], [], `${role} /repo/mentors`);
      await page("mentor/[id]/page.tsx", w.mentorB);
      const home = await page("page.tsx");
      assert.doesNotMatch(home.text, /Your own records/);
      const teachers = Number(/Teachers (\d+) Mentors/.exec(home.text)?.[1]);
      assert.ok(teachers >= 2, `${role} /repo counts every teacher (${teachers})`);
    }

    // The learner roster stays with administrators (and now each teacher's own).
    as(w.users.admin, "programme_admin");
    shows(
      (await page("students/page.tsx", "", { q: w.T })).text,
      [n.learnerA, n.learnerB, n.learner4a, n.learner4b],
      [],
      "admin /repo/students",
    );
    shows((await page("class/[id]/learners/page.tsx", w.classK4)).text, [n.learner4a, n.learner4b], [], "admin roster");
    as(w.users.mentor, "mentor");
    assert.deepEqual(await open("students/page.tsx"), { status: "redirect", location: "/forbidden" }, "a mentor reads no learner roster");
    assert.deepEqual(
      await open("class/[id]/learners/page.tsx", w.classK1),
      { status: "redirect", location: "/forbidden" },
      "a mentor reads no class roster",
    );
  });
});

test("a teacher login with no teachers record owns nothing in the Repository", { skip }, async () => {
  await withWorld(async (w) => {
    const n = w.names;
    as(w.users.noRow, "teacher");
    shows((await page("teachers/page.tsx", "", { q: w.T })).text, [], [n.teacherA, n.teacherB], "/repo/teachers");
    shows((await page("sessions/page.tsx", "", { q: w.T })).text, [], [w.topicA, w.topicB], "/repo/sessions");
    shows((await page("students/page.tsx", "", { q: w.T })).text, [], [n.learnerA, n.learnerB], "/repo/students");
    shows((await page("outlines/page.tsx", "", { q: w.T })).text, [n.outlineP], [n.planA, n.planB], "/repo/outlines");
    shows((await page("mentors/page.tsx", "", { q: w.T })).text, [], [n.mentorA, n.mentorB], "/repo/mentors");
    await is404("teacher/[id]/page.tsx", w.teacherA, "any teacher's profile");
    await is404("school/[id]/page.tsx", w.schoolS1, "any school");
    await is404("class/[id]/page.tsx", w.classK1, "any class");
    await is404("session/[id]/page.tsx", w.sessionA, "any session");
    await page("subject/[id]/page.tsx", w.subject);
  });
});

test("a teacher's own Repository reads in Hindi and Bhoti", { skip }, async () => {
  await withWorld(async (w) => {
    as(w.users.teacherA, "teacher");
    try {
      request.locale = "hi";
      const subject = await page("subject/[id]/page.tsx", w.subject);
      shows(subject.text, ["आपके सत्र (1)", w.topicA], ["Your sessions", w.topicB], "hi /repo/subject");
      request.locale = "bo";
      const session = await page("session/[id]/page.tsx", w.sessionA);
      shows(session.text, ["ཆོག་མཆན་སྒུག་བཞིན།", w.topicA], ["Pending approval"], "bo /repo/session");
      const home = await page("page.tsx");
      shows(home.text, ["ཁྱེད་རང་གི་ཡིག་ཐོ་ཁོ་ན།"], ["Your own records"], "bo /repo");
    } finally {
      request.locale = "en";
    }
  });
});

test("a teacher's own Repository pages fit a phone", { skip }, async () => {
  await withWorld(async (w) => {
    as(w.users.teacherA, "teacher");
    request.cookies = { "gml-device": "mobile" };
    try {
      const failures: string[] = [];
      for (const [file, id] of [
        ["page.tsx", ""],
        ["teachers/page.tsx", ""],
        ["sessions/page.tsx", ""],
        ["outlines/page.tsx", ""],
        ["students/page.tsx", ""],
        ["school/[id]/page.tsx", w.schoolS1],
        ["class/[id]/page.tsx", w.classK1],
        ["class/[id]/learners/page.tsx", w.classK1],
        ["subject/[id]/page.tsx", w.subject],
        ["session/[id]/page.tsx", w.sessionA],
        ["outline/[id]/page.tsx", w.planA],
        ["teacher/[id]/page.tsx", w.teacherA],
      ] as const) {
        const { html } = await page(file, id);
        for (const issue of await phoneLayoutIssues(html)) failures.push(`/repo/${file} ${issue}`);
      }
      assert.deepEqual(failures, [], `at ${PHONE_WIDTH}px`);
    } finally {
      request.cookies = {};
    }
  });
});
