import "server-only";

// A session's attendance as a CSV (/teaching/sessions/[id]): the roster she
// downloads, and the file she uploads back.
//
//   columns   student (the name) and/or rollNumber, to say who; status to say
//             what: present, absent, late or excused, in any case, or the same
//             word as the page shows it in her language. The downloaded roster
//             also carries section, which picks among students a name or a roll
//             number alone does not (a whole-grade session: rolls restart in
//             every section).
//   who       found ONLY among this session's roster (the class and section of
//             the session, lib/teaching roster()), never in the school. A name
//             two students share, or a roll number nobody has, is a row's
//             problem; so is a status that is none of the four. A roll number
//             is compared without leading zeros: Excel turns 01 into 1.
//   rows      a row that cannot be used is reported with its line and the rest
//             still count. A student the file does not name is left as she was:
//             unmarked stays unmarked, never present.

import { ATTENDANCE_STATUSES, type AttendanceStatus } from "./records";
import { fold, type CsvRow, type Translate } from "./csv";

/** Header spellings (see csv.ts headerKey) and the column each means. */
export const ATTENDANCE_COLUMNS: Record<string, string> = {
  student: "student",
  studentname: "student",
  name: "student",
  rollnumber: "rollNumber",
  rollno: "rollNumber",
  roll: "rollNumber",
  status: "status",
  attendance: "status",
  section: "section",
};

/** The columns of the downloaded roster, as written. */
export const ROSTER_COLUMNS = ["student", "rollNumber", "section", "status"];

/** attendance-grade5A-2026-10-05.csv: the class and the day, so rosters of several sessions can be told apart. */
export function rosterFilename(grade: number, section: string | null, date: string): string {
  return `attendance-grade${grade}${(section ?? "").replace(/[^A-Za-z0-9]/g, "")}-${date}.csv`;
}

type Student = { id: string; name: string; rollNumber: string | null; section: string | null };

export type MarkProblem = { line: number; message: string };

/**
 * A roll number as compared: folded, and a whole number without its leading
 * zeros, since a spreadsheet writes the roster's 01 back as 1. A roster that
 * holds both 1 and 01 therefore cannot tell them apart by roll alone: the row
 * is reported as ambiguous, never guessed.
 */
const rollKey = (roll: string): string => fold(roll).replace(/^0+(?=\d+$)/, "");

/** What each word a file may use for a status means: English, and her language's. */
export function statusWords(t: Translate): Map<string, AttendanceStatus> {
  const words = new Map<string, AttendanceStatus>();
  for (const status of ATTENDANCE_STATUSES) {
    words.set(status, status);
    words.set(fold(t(`attendance.${status}`)), status);
  }
  return words;
}

/**
 * The marks the rows of a file give the session's roster, and the rows that
 * give none, each with what is wrong. A student named twice keeps the first
 * row; the second is reported.
 */
export function marksFromRows(
  t: Translate,
  students: readonly Student[],
  rows: readonly CsvRow[],
): { marks: Array<{ learnerId: string; status: AttendanceStatus }>; problems: MarkProblem[] } {
  const words = statusWords(t);
  // Compared as folded text; a roster is folded once, not once per row of the file.
  const roster = students.map((s) => ({ student: s, name: fold(s.name), roll: rollKey(s.rollNumber ?? ""), section: fold(s.section ?? "") }));
  const statuses = ATTENDANCE_STATUSES.map((s) => t(`attendance.${s}`).toLowerCase()).join(", ");
  const marks: Array<{ learnerId: string; status: AttendanceStatus }> = [];
  const problems: MarkProblem[] = [];
  const firstLine = new Map<string, number>();

  for (const { line, cells } of rows) {
    const name = cells.student ?? "";
    const roll = cells.rollNumber ?? "";
    const problem = (message: string) => problems.push({ line, message });
    if (!name && !roll) {
      problem(t("csv.attendance.studentRequired"));
      continue;
    }
    // A roll number and a name given together must name the same student.
    const who = name || t("csv.roll", { roll });
    const wantName = fold(name);
    const wantRoll = rollKey(roll);
    const section = fold(cells.section ?? "");
    const named = (s: (typeof roster)[number]) => !name || s.name === wantName;
    let found = roster.filter((s) => (!roll || s.roll === wantRoll) && named(s));
    // Several match: the section cell, when the file has one, picks among them.
    if (found.length > 1 && section) {
      const there = found.filter((s) => s.section === section);
      if (there.length > 0) found = there;
    }
    if (found.length === 0) {
      const label = name && roll ? `${name} (${t("csv.roll", { roll })})` : who;
      // Both given and no one student fits both: when the roll alone, or the name alone, finds exactly one, say which part is wrong.
      const byRoll = name && roll ? roster.filter((s) => s.roll === wantRoll) : [];
      const byName = name && roll ? roster.filter(named) : [];
      if (byRoll.length === 1 && byName.length === 0) {
        problem(t("csv.attendance.nameMismatch", { who: label, roll: t("csv.roll", { roll }), actual: byRoll[0]!.student.name }));
      } else if (byName.length === 1 && byRoll.length === 0) {
        const actual = byName[0]!.student.rollNumber ? t("csv.roll", { roll: byName[0]!.student.rollNumber }) : t("csv.noRoll");
        problem(t("csv.attendance.rollMismatch", { who: label, name, actual }));
      } else {
        problem(t("csv.attendance.notOnRoster", { who: label }));
      }
      continue;
    }
    if (found.length > 1) {
      // The candidates, by roll number and, when they are in different sections, by section too.
      const bySection = new Set(found.map((s) => s.section)).size > 1;
      const options = found
        .map((s) => {
          const r = s.student.rollNumber ? t("csv.roll", { roll: s.student.rollNumber }) : t("csv.noRoll");
          return bySection && s.student.section ? `${r}, ${t("csv.section", { section: s.student.section })}` : r;
        })
        .join(bySection ? "; " : ", ");
      // What the file can still say: the roll number, then the section; else nothing it holds will do.
      const apart = (keys: string[]) => keys.every(Boolean) && new Set(keys).size === keys.length;
      const how = !roll && apart(found.map((s) => s.roll)) ? "ambiguous" : !section && apart(found.map((s) => s.section)) ? "ambiguousSection" : "ambiguousSame";
      problem(t(`csv.attendance.${how}`, { who, count: found.length, options }));
      continue;
    }
    const student = found[0]!.student;

    const raw = cells.status ?? "";
    if (!raw) {
      problem(t("csv.attendance.statusMissing", { who, statuses }));
      continue;
    }
    const status = words.get(fold(raw));
    if (!status) {
      problem(t("csv.attendance.badStatus", { value: raw, statuses }));
      continue;
    }
    const earlier = firstLine.get(student.id);
    if (earlier !== undefined) {
      problem(t("csv.attendance.repeats", { who, first: earlier }));
      continue;
    }
    firstLine.set(student.id, line);
    marks.push({ learnerId: student.id, status });
  }
  return { marks, problems };
}
