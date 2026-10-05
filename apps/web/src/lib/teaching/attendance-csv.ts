import "server-only";

// A session's attendance as a CSV (/teaching/sessions/[id]): the roster she
// downloads, and the file she uploads back.
//
//   columns   student (the name) and/or rollNumber, to say who; status to say
//             what: present, absent, late or excused, in any case, or the same
//             word as the page shows it in her language. The downloaded roster
//             also carries section, which is read for nothing.
//   who       found ONLY among this session's roster (the class and section of
//             the session, lib/teaching roster()), never in the school. A name
//             two students share, or a roll number nobody has, is a row's
//             problem; so is a status that is none of the four.
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

type Student = { id: string; name: string; rollNumber: string | null };

export type MarkProblem = { line: number; message: string };

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
  const roster = students.map((s) => ({ student: s, name: fold(s.name), roll: fold(s.rollNumber ?? "") }));
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
    const found = roster.filter((s) => (!roll || s.roll === fold(roll)) && (!name || s.name === fold(name))).map((s) => s.student);
    if (found.length === 0) {
      problem(t("csv.attendance.notOnRoster", { who: name && roll ? `${name} (${t("csv.roll", { roll })})` : who }));
      continue;
    }
    if (found.length > 1) {
      const options = found.map((s) => (s.rollNumber ? t("csv.roll", { roll: s.rollNumber }) : t("csv.noRoll"))).join(", ");
      problem(t("csv.attendance.ambiguous", { who, count: found.length, options }));
      continue;
    }
    const student = found[0]!;

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
