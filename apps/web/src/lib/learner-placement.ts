// Where a class is: the school and grade a student placed in it takes.
//
// A student row carries class_id, school_id and grade, and the three used to be
// three unrelated answers: the grid and the CSV import saved a student at one
// school in another school's class, or as Grade 9 in a Grade 5 class. The class
// is the authority. Given one, a blank school or grade is the class's, and a
// school or grade that differs from it is a clash.
//
// This is the one place that knows it. The admin grid's create and update and
// the CSV import reach it through the learners entity (admin/rules.ts), the
// teacher's add-student screen through classPlacement, and a trigger on learners
// (_post/016) holds the same rule for any other writer. No server-only marker,
// and the database is a parameter: the entity definitions that use this are
// also read by the client form, which never calls it (as admin/rules.ts).

import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { classes, schools } from "@gml/db/schema";

type Db = NodePgDatabase<Record<string, unknown>>;

export type ClassPlacement = { schoolId: string; grade: number };

/** Nothing was given: an omitted column, a NULL, or an emptied box. */
export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** The school and grade of a class, or null when there is no such class. */
export async function classPlacement(db: Db, classId: string): Promise<ClassPlacement | null> {
  const [found] = await db
    .select({ schoolId: classes.schoolId, grade: classes.grade })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  return found ?? null;
}

/** "Name (CODE)", as the grid's school drop-down shows a school. */
async function schoolLabels(db: Db, ids: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: schools.id, name: schools.name, code: schools.code })
    .from(schools)
    .where(inArray(schools.id, ids));
  return new Map(rows.map((r) => [r.id, `${r.name} (${r.code})`]));
}

export type PlacementVerdict =
  | { kind: "noClass" }
  | { kind: "fits" }
  | {
      kind: "clash";
      /** The student's school and the class's, as labels a person can read. */
      school?: { given: string; expected: string };
      grade?: { given: number; expected: number };
    };

/**
 * Whether the school and grade given with a class agree with it. A blank one
 * agrees (it is filled from the class); a school that is not a school at all is
 * the foreign key's to report, not a clash.
 */
export async function checkPlacement(
  db: Db,
  classId: string,
  given: { schoolId?: unknown; grade?: unknown },
): Promise<PlacementVerdict> {
  const cls = await classPlacement(db, classId);
  if (!cls) return { kind: "noClass" };

  const clash: { school?: { given: string; expected: string }; grade?: { given: number; expected: number } } = {};
  if (typeof given.schoolId === "string" && given.schoolId !== cls.schoolId) {
    const labels = await schoolLabels(db, [given.schoolId, cls.schoolId]);
    const label = labels.get(given.schoolId);
    if (label) clash.school = { given: label, expected: labels.get(cls.schoolId) ?? cls.schoolId };
  }
  if (!isBlank(given.grade) && Number(given.grade) !== cls.grade) {
    clash.grade = { given: Number(given.grade), expected: cls.grade };
  }
  return clash.school || clash.grade ? { kind: "clash", ...clash } : { kind: "fits" };
}
