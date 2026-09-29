// Teachers' attendance at RTT sessions: who a session is for, and the marks a
// programme admin takes of them (/attendance, /attendance/[rttSessionId]).
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// rtt_attendance was written only through the super_admin data grid, one row
// at a time, and nothing set marked_by_user_id: a teacher's "Sessions
// attended" and the staff attendance table (lib/rtt/progress.ts) read rows
// nobody had a screen to take. The design (docs/superpowers/specs/
// 2026-09-28-teaching-records-design.md): a programme admin opens an RTT
// session, sees the teachers it covers, marks each one present, absent, late
// or excused, and saves.
//
// ── WHO A SESSION IS FOR ─────────────────────────────────────────────────────
//
// A session belongs to an RTT subject, and a subject is taught to the whole
// programme, one district or one zone (rtt_subjects.district_id / zone_id,
// lib/rtt/scope.ts). Its roster is the ACTIVE teachers whose school is in
// that place -- the same teachersIn() predicate /rtt/progress filters staff
// rows by -- plus anyone already marked at it, so a mark taken before a
// teacher moved school or was deactivated is still shown (flagged as no
// longer on the roster) rather than silently hidden.
//
// ── SAVING ───────────────────────────────────────────────────────────────────
//
// One upsert per save, on the (session, teacher) unique index. A row whose
// status did not change is left as it is, so "marked by ... when" keeps
// saying who actually took that mark, not who last pressed Save on the page.
// A teacher not on the roster refuses the whole save: the form only lists
// roster teachers, so anything else is a crafted post.
//
// Takes the database as a parameter so the behaviour suite can run it.

import { and, asc, count, desc, eq, gte, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  attendanceStatusEnum,
  districts,
  rttAttendance,
  rttSessions,
  rttSubjects,
  schools,
  teachers,
  users,
  zones,
} from "@gml/db/schema";
import { teachersIn, type Place } from "./scope";
import type { AttendanceStatus } from "./progress";

type Db = NodePgDatabase<Record<string, unknown>>;

/** Every status a mark can take, in the order the marking screen offers them. */
export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = attendanceStatusEnum.enumValues;
/** The order the radio buttons read in: the common case first. */
export const MARKING_ORDER: readonly AttendanceStatus[] = ["present", "late", "absent", "excused"];

export function isAttendanceStatus(v: unknown): v is AttendanceStatus {
  return typeof v === "string" && (ATTENDANCE_STATUSES as readonly string[]).includes(v);
}

/** Attended, for a count of sessions attended: on time or late. */
export const ATTENDED: readonly AttendanceStatus[] = ["present", "late"];

/** The programme's clock, for "sessions on this day". */
export const PROGRAMME_TIME_ZONE = "Asia/Kolkata";

// ── where a subject is taught ────────────────────────────────────────────────

type SubjectPlaceIds = { districtId: string | null; zoneId: string | null };

/**
 * The place a subject is taught in (a zone names its own district), or null
 * for the whole programme.
 */
export async function subjectPlace(db: Db, subject: SubjectPlaceIds): Promise<Place | null> {
  if (subject.zoneId) {
    const [z] = await db
      .select({ districtId: districts.id, districtName: districts.name, zoneId: zones.id, zoneName: zones.name })
      .from(zones)
      .innerJoin(districts, eq(districts.id, zones.districtId))
      .where(eq(zones.id, subject.zoneId))
      .limit(1);
    return z ?? null;
  }
  if (subject.districtId) {
    const [d] = await db
      .select({ districtId: districts.id, districtName: districts.name })
      .from(districts)
      .where(eq(districts.id, subject.districtId))
      .limit(1);
    return d ? { ...d, zoneId: null, zoneName: null } : null;
  }
  return null;
}

/** The active teachers a subject taught in `place` is for. */
function rosterWhere(place: Place | null): SQL {
  return and(eq(teachers.active, true), teachersIn(place))!;
}

/** How many active teachers a subject taught in `place` is for. */
export async function rosterSize(db: Db, place: Place | null): Promise<number> {
  const [row] = await db.select({ n: count() }).from(teachers).where(rosterWhere(place));
  return row?.n ?? 0;
}

// ── the sessions list ────────────────────────────────────────────────────────

export type MarkingSessionRow = {
  id: string;
  title: string;
  scheduledAt: Date | null;
  type: string | null;
  durationMin: number | null;
  subjectId: string;
  subjectName: string;
  subjectActive: boolean;
  /** Where the subject is taught; null for the whole programme. */
  place: Place | null;
  /** Marks taken at the session. */
  marked: number;
  /** Active teachers the session is for. */
  rosterSize: number;
};

/** How many sessions each group of the list shows. */
export const SESSION_LIST_LIMIT = 50;

export type SessionFilter = {
  subjectId?: string | null;
  /** A calendar day, YYYY-MM-DD, in the programme's time zone. */
  date?: string | null;
  now?: Date;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD that is a real calendar day, or null. */
export function parseDay(raw: unknown): string | null {
  if (typeof raw !== "string" || !DAY.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : raw;
}

async function sessionRows(db: Db, where: SQL | undefined, order: SQL[]): Promise<{ rows: MarkingSessionRow[]; more: boolean }> {
  const rows = await db
    .select({
      id: rttSessions.id,
      title: rttSessions.title,
      scheduledAt: rttSessions.scheduledAt,
      type: rttSessions.type,
      durationMin: rttSessions.durationMin,
      subjectId: rttSubjects.id,
      subjectName: rttSubjects.name,
      subjectActive: rttSubjects.active,
      districtId: rttSubjects.districtId,
      zoneId: rttSubjects.zoneId,
      marked: sql<number>`(SELECT count(*) FROM ${rttAttendance} WHERE ${rttAttendance.rttSessionId} = ${rttSessions.id})::int`,
    })
    .from(rttSessions)
    .innerJoin(rttSubjects, eq(rttSubjects.id, rttSessions.rttSubjectId))
    .where(where)
    .orderBy(...order)
    .limit(SESSION_LIST_LIMIT + 1);

  // One place and one roster count per subject, not per session.
  const places = new Map<string, { place: Place | null; size: number }>();
  for (const r of rows) {
    if (places.has(r.subjectId)) continue;
    const place = await subjectPlace(db, r);
    places.set(r.subjectId, { place, size: await rosterSize(db, place) });
  }
  return {
    rows: rows.slice(0, SESSION_LIST_LIMIT).map(({ districtId: _d, zoneId: _z, ...r }) => ({
      ...r,
      place: places.get(r.subjectId)!.place,
      rosterSize: places.get(r.subjectId)!.size,
    })),
    more: rows.length > SESSION_LIST_LIMIT,
  };
}

export type SessionGroups =
  | { kind: "day"; day: string; sessions: MarkingSessionRow[]; more: boolean }
  | {
      kind: "window";
      upcoming: MarkingSessionRow[];
      recent: MarkingSessionRow[];
      unscheduled: MarkingSessionRow[];
      more: boolean;
    };

/**
 * The RTT sessions a programme admin marks. With a day: that day's sessions,
 * in time order. Without: the next ones coming up (soonest first), the ones
 * just held (latest first), and any with no date yet.
 */
export async function listMarkingSessions(db: Db, f: SessionFilter = {}): Promise<SessionGroups> {
  const bySubject = f.subjectId ? eq(rttSessions.rttSubjectId, f.subjectId) : undefined;
  const day = parseDay(f.date);
  if (day) {
    const onDay = sql`(${rttSessions.scheduledAt} AT TIME ZONE ${PROGRAMME_TIME_ZONE})::date = ${day}::date`;
    const { rows, more } = await sessionRows(db, and(bySubject, onDay), [asc(rttSessions.scheduledAt), asc(rttSessions.id)]);
    return { kind: "day", day, sessions: rows, more };
  }
  const now = f.now ?? new Date();
  const [upcoming, recent, unscheduled] = await Promise.all([
    sessionRows(db, and(bySubject, gte(rttSessions.scheduledAt, now)), [asc(rttSessions.scheduledAt), asc(rttSessions.id)]),
    sessionRows(db, and(bySubject, lt(rttSessions.scheduledAt, now)), [desc(rttSessions.scheduledAt), desc(rttSessions.id)]),
    sessionRows(db, and(bySubject, isNull(rttSessions.scheduledAt)), [asc(rttSubjects.name), asc(rttSessions.sequence)]),
  ]);
  return {
    kind: "window",
    upcoming: upcoming.rows,
    recent: recent.rows,
    unscheduled: unscheduled.rows,
    more: upcoming.more || recent.more || unscheduled.more,
  };
}

// ── one session ──────────────────────────────────────────────────────────────

export type MarkingSession = Omit<MarkingSessionRow, "marked" | "rosterSize">;

/** The session, its subject and where the subject is taught; null if there is no such session. */
export async function markingSession(db: Db, sessionId: string): Promise<MarkingSession | null> {
  const [s] = await db
    .select({
      id: rttSessions.id,
      title: rttSessions.title,
      scheduledAt: rttSessions.scheduledAt,
      type: rttSessions.type,
      durationMin: rttSessions.durationMin,
      subjectId: rttSubjects.id,
      subjectName: rttSubjects.name,
      subjectActive: rttSubjects.active,
      districtId: rttSubjects.districtId,
      zoneId: rttSubjects.zoneId,
    })
    .from(rttSessions)
    .innerJoin(rttSubjects, eq(rttSubjects.id, rttSessions.rttSubjectId))
    .where(eq(rttSessions.id, sessionId))
    .limit(1);
  if (!s) return null;
  const { districtId, zoneId, ...rest } = s;
  return { ...rest, place: await subjectPlace(db, { districtId, zoneId }) };
}

export type RosterEntry = {
  teacherId: string;
  fullName: string;
  hindiName: string | null;
  schoolName: string;
  zoneName: string;
  /** The mark taken, or null while none is. */
  status: AttendanceStatus | null;
  markedAt: Date | null;
  /** Who took the mark: the account's name, else its email; null when unknown (a grid row, a deleted account). */
  markedBy: string | null;
  /** False for someone marked here who is no longer an active teacher of the subject's place. */
  onRoster: boolean;
};

/** The session's roster (see the header), school by school. */
export async function sessionRoster(db: Db, session: Pick<MarkingSession, "id" | "place">): Promise<RosterEntry[]> {
  const inRoster = rosterWhere(session.place);
  const rows = await db
    .select({
      teacherId: teachers.id,
      fullName: teachers.fullName,
      hindiName: teachers.hindiName,
      schoolName: schools.name,
      zoneName: zones.name,
      status: rttAttendance.status,
      markedAt: rttAttendance.markedAt,
      markedBy: sql<string | null>`coalesce(${users.name}, ${users.email})`,
      onRoster: sql<boolean>`(${inRoster})`,
    })
    .from(teachers)
    .innerJoin(schools, eq(schools.id, teachers.schoolId))
    .innerJoin(zones, eq(zones.id, schools.zoneId))
    .leftJoin(rttAttendance, and(eq(rttAttendance.teacherId, teachers.id), eq(rttAttendance.rttSessionId, session.id)))
    .leftJoin(users, eq(users.id, rttAttendance.markedByUserId))
    .where(or(inRoster, isNotNull(rttAttendance.id)))
    .orderBy(asc(schools.name), asc(teachers.fullName), asc(teachers.id));
  return rows.map((r) => ({ ...r, onRoster: Boolean(r.onRoster) }));
}

// ── marking ──────────────────────────────────────────────────────────────────

export type MarkResult =
  | { ok: true; changed: number; counts: Record<AttendanceStatus, number> }
  | { ok: false; error: "not_found" | "not_on_roster" };

const emptyCounts = (): Record<AttendanceStatus, number> =>
  Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, 0])) as Record<AttendanceStatus, number>;

/**
 * Save marks for a session as `actorId`. `marks` maps a teacher to the status
 * chosen for her; with `fillPresent`, every roster teacher left out of it is
 * marked present ("Mark all present"). Only rows whose status changes are
 * written; `changed` counts them, and `counts` what they were changed to.
 */
export async function markAttendance(
  db: Db,
  input: {
    sessionId: string;
    marks: ReadonlyMap<string, AttendanceStatus>;
    fillPresent?: boolean;
    actorId: string;
  },
): Promise<MarkResult> {
  const session = await markingSession(db, input.sessionId);
  if (!session) return { ok: false, error: "not_found" };
  const roster = await sessionRoster(db, session);
  const known = new Set(roster.map((r) => r.teacherId));
  for (const teacherId of input.marks.keys()) {
    if (!known.has(teacherId)) return { ok: false, error: "not_on_roster" };
  }

  const wanted = new Map(input.marks);
  if (input.fillPresent) {
    for (const r of roster) if (r.onRoster && !wanted.has(r.teacherId)) wanted.set(r.teacherId, "present");
  }
  if (wanted.size === 0) return { ok: true, changed: 0, counts: emptyCounts() };

  const markedAt = new Date();
  const written = await db
    .insert(rttAttendance)
    .values(
      [...wanted].map(([teacherId, status]) => ({
        rttSessionId: session.id,
        teacherId,
        status,
        markedByUserId: input.actorId,
        markedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [rttAttendance.rttSessionId, rttAttendance.teacherId],
      set: {
        status: sql`excluded.status`,
        markedByUserId: sql`excluded.marked_by_user_id`,
        markedAt: sql`excluded.marked_at`,
      },
      // An unchanged mark keeps who took it and when.
      setWhere: sql`${rttAttendance.status} IS DISTINCT FROM excluded.status`,
    })
    .returning({ status: rttAttendance.status });

  const counts = emptyCounts();
  for (const w of written) counts[w.status] += 1;
  return { ok: true, changed: written.length, counts };
}

