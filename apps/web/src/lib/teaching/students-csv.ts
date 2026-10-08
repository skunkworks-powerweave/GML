import "server-only";

// Her students as a CSV (/teaching/students): many added at once, into the
// classes she is linked to and no others.
//
//   columns   name; rollNumber; section; class. Nothing else is read -- above
//             all not a school, a grade or a class id: those are DERIVED from
//             the class she names, so a file cannot put a child in a school or
//             a grade her class is not in.
//   class     the label she sees ("Grade 5 A", "Grade 6 (all sections)"), or
//             the grade ("Grade 5", "5", "5 B"), among HER classes only; blank
//             when she teaches one class. Another school's class, or a grade
//             she is not linked to, is that row's problem.
//   section   a link to section A puts a student in section A (a typed B is
//             refused: she does not teach it); a link to the whole grade takes
//             any section, or none. Several links to one class that each name
//             a section need the section said.
//   rows      a row that cannot be added is reported with its line and the
//             rest still land. A student already in the class (same name, or
//             same roll number, in the same section), or repeated earlier in
//             the file, is reported and not added again. A student with no
//             section is on every section's roster (lib/teaching roster()), so
//             she collides with the same name or roll in ANY section. A cell
//             with a line break or another control character is refused: a
//             name is one line, and a NUL byte would sink the whole insert.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { learners } from "@gml/db/schema";
import type { Db } from "@/lib/visibility";
import type { ClassLink } from "./index";
import { fold, type CsvRow, type Translate } from "./csv";
import { parseSection } from "./records";

/** Header spellings (see csv.ts headerKey) and the column each means. */
export const STUDENT_COLUMNS: Record<string, string> = {
  name: "name",
  student: "name",
  studentname: "name",
  rollnumber: "rollNumber",
  rollno: "rollNumber",
  roll: "rollNumber",
  section: "section",
  class: "class",
};

/** The columns of the template, as written. */
export const TEMPLATE_COLUMNS = ["name", "rollNumber", "section", "class"];

export type NewStudent = {
  classId: string;
  schoolId: string;
  grade: number;
  section: string | null;
  name: string;
  rollNumber: string | null;
};

type Taught = { classId: string; schoolId: string; grade: number; sections: Array<string | null> };

/** A line break, a tab, a NUL: not part of a name, a roll number or a section. */
const hasControl = (value: string): boolean => /\p{Cc}/u.test(value);

/** A class the way her pages label it (teaching/_components/ui.tsx classLabel). */
const label = (t: Translate, grade: number, section: string | null): string =>
  section ? t("common.gradeSection", { grade, section }) : t("common.gradeAll", { grade });

/**
 * The students a file adds, and the rows that add none, each with what is
 * wrong. `links` are HER class links (lib/teaching myClassLinks): the only
 * classes a row may name.
 */
export async function studentsFromRows(
  db: Db,
  t: Translate,
  links: readonly ClassLink[],
  rows: readonly CsvRow[],
): Promise<{ students: Array<NewStudent & { line: number }>; problems: Array<{ line: number; message: string }> }> {
  const taught = new Map<string, Taught>();
  for (const l of links) {
    const c = taught.get(l.classId) ?? { classId: l.classId, schoolId: l.schoolId, grade: l.grade, sections: [] };
    c.sections.push(l.section);
    taught.set(l.classId, c);
  }
  const options = links.map((l) => label(t, l.grade, l.section)).join(", ");

  /** The class a cell names among hers, with the section the cell itself implies; or why not. */
  const findClass = (cell: string): { taught: Taught; section: string | null } | "none" | "many" => {
    const key = fold(cell);
    const byLabel = links.filter((l) => fold(label(t, l.grade, l.section)) === key);
    if (byLabel.length > 0) {
      return new Set(byLabel.map((l) => l.classId)).size > 1
        ? "many"
        : { taught: taught.get(byLabel[0]!.classId)!, section: byLabel[0]!.section };
    }
    const byGrade = [...taught.values()].filter((c) => fold(t("common.gradeN", { grade: c.grade })) === key);
    if (byGrade.length > 0) return byGrade.length > 1 ? "many" : { taught: byGrade[0]!, section: null };
    // "5", "Grade 5", "5 B", "Grade 5 B".
    const m = /^(?:grade\s*)?(\d{1,2})(?:\s+(.+))?$/i.exec(cell.replace(/\s+/g, " ").trim());
    if (!m) return "none";
    const section = m[2] === undefined ? null : parseSection(m[2]);
    if (section === undefined) return "none";
    const grade = [...taught.values()].filter((c) => c.grade === Number(m[1]));
    return grade.length === 0 ? "none" : grade.length > 1 ? "many" : { taught: grade[0]!, section };
  };

  const problems: Array<{ line: number; message: string }> = [];
  const wanted: Array<NewStudent & { line: number }> = [];
  for (const { line, cells } of rows) {
    const problem = (message: string) => problems.push({ line, message });
    const name = cells.name ?? "";
    if (!name) {
      problem(t("errors.nameRequired"));
      continue;
    }
    if (name.length > 160) {
      problem(t("errors.tooLong", { field: t("fields.name"), max: 160 }));
      continue;
    }
    const roll = cells.rollNumber ?? "";
    if (roll.length > 32) {
      problem(t("errors.tooLong", { field: t("fields.rollNumber"), max: 32 }));
      continue;
    }
    if (hasControl(name) || hasControl(roll) || hasControl(cells.section ?? "")) {
      problem(t("csv.students.badCharacters"));
      continue;
    }

    const cell = cells.class ?? "";
    let found: ReturnType<typeof findClass>;
    if (cell) found = findClass(cell);
    else if (taught.size === 1) found = { taught: [...taught.values()][0]!, section: null };
    else {
      problem(t("csv.students.classRequired", { options }));
      continue;
    }
    if (found === "none") {
      problem(t("csv.students.classUnknown", { value: cell, options }));
      continue;
    }
    if (found === "many") {
      problem(t("csv.students.classAmbiguous", { value: cell, options }));
      continue;
    }

    const typed = parseSection(cells.section ?? "");
    if (typed === undefined) {
      problem(t("errors.sectionInvalid"));
      continue;
    }
    if (typed && found.section && typed !== found.section) {
      problem(t("csv.students.sectionConflict", { fromClass: found.section, typed }));
      continue;
    }
    let section = typed ?? found.section;
    const named = [...new Set(found.taught.sections.filter((s): s is string => s !== null))];
    // Her links to this class all name a section: the student goes into one of them.
    if (!found.taught.sections.includes(null)) {
      if (section === null) {
        if (named.length !== 1) {
          problem(t("csv.students.sectionNeeded", { sections: named.join(", ") }));
          continue;
        }
        section = named[0]!;
      } else if (!named.includes(section)) {
        problem(t("errors.sectionNotYours"));
        continue;
      }
    }
    wanted.push({
      line,
      classId: found.taught.classId,
      schoolId: found.taught.schoolId,
      grade: found.taught.grade,
      section,
      name,
      rollNumber: roll || null,
    });
  }

  // Already there, or already earlier in this file.
  const classIds = [...new Set(wanted.map((w) => w.classId))];
  const stored =
    classIds.length === 0
      ? []
      : await db
          .select({ classId: learners.classId, name: learners.name, rollNumber: learners.rollNumber, section: learners.section })
          .from(learners)
          .where(and(inArray(learners.classId, classIds), eq(learners.active, true), isNull(learners.deletedAt)));
  // line: null for a student on the class list already, else the line of this file that adds her.
  type Seen = { section: string | null; line: number | null };
  const names = new Map<string, Seen[]>();
  const rolls = new Map<string, Seen[]>();
  const remember = (map: Map<string, Seen[]>, key: string, seen: Seen) => map.set(key, [...(map.get(key) ?? []), seen]);
  const nameKey = (s: { classId: string; name: string }) => `${s.classId}|${fold(s.name)}`;
  const rollKey = (s: { classId: string }, roll: string) => `${s.classId}|${fold(roll)}`;
  // The same section, or either has none: she is on every section's roster. The class list's own come first.
  const clash = (seen: Seen[] | undefined, section: string | null) =>
    seen?.find((s) => s.section === null || section === null || s.section === section);
  const whereIs = (grade: number, section: string | null) =>
    section ? t("common.gradeSection", { grade, section }) : t("common.gradeN", { grade });
  for (const s of stored) {
    remember(names, nameKey(s), { section: s.section, line: null });
    if (s.rollNumber) remember(rolls, rollKey(s, s.rollNumber), { section: s.section, line: null });
  }

  const students: Array<NewStudent & { line: number }> = [];
  for (const w of wanted) {
    const sameName = clash(names.get(nameKey(w)), w.section);
    const sameRoll = w.rollNumber ? clash(rolls.get(rollKey(w, w.rollNumber)), w.section) : undefined;
    if (sameName && sameName.line === null) {
      problems.push({ line: w.line, message: t("csv.students.duplicateName", { name: w.name, where: whereIs(w.grade, sameName.section) }) });
    } else if (sameRoll && sameRoll.line === null) {
      problems.push({ line: w.line, message: t("csv.students.duplicateRoll", { roll: w.rollNumber!, where: whereIs(w.grade, sameRoll.section) }) });
    } else if (sameName) {
      problems.push({ line: w.line, message: t("csv.students.repeats", { name: w.name, first: sameName.line! }) });
    } else if (sameRoll) {
      problems.push({ line: w.line, message: t("csv.students.rollRepeats", { roll: w.rollNumber!, first: sameRoll.line! }) });
    } else {
      remember(names, nameKey(w), { section: w.section, line: w.line });
      if (w.rollNumber) remember(rolls, rollKey(w, w.rollNumber), { section: w.section, line: w.line });
      students.push(w);
    }
  }
  return { students, problems };
}
