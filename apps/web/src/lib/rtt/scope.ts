// Which RTT subjects a viewer is shown: ONE predicate for every RTT surface
// (/rtt, the subject page, the progress tick, the open-quiz list and the
// dashboard's count of it, /rtt/progress and the webinar calendar).
//
// ── INACTIVE SUBJECTS (F43) ──────────────────────────────────────────────────
//
// The admin grid has an Active flag on RTT subjects and the self-paced hub
// honoured it, but /rtt listed, counted and linked every subject and the
// subject page never looked: retiring a subject changed nothing teachers saw.
// Only an administrator -- who may need to re-activate one -- still sees an
// inactive subject, marked as such.
//
// ── DISTRICT > ZONE (F42) ────────────────────────────────────────────────────
//
// RTT runs district > zone > term > subject, and /rtt showed every subject to
// everyone under a hard-coded "across Leh + Kargil". A subject is now taught
// to the whole programme, one district, or one zone (rtt_subjects.district_id
// / zone_id, migration 0038), and a place shows:
//   the programme-wide subjects, the district's, and -- for a zone -- that
//   zone's (a district shows the subjects of every zone in it).
// A TEACHER is always shown her own place, from the existing chain teachers ->
// schools -> zones -> districts; a teacher with no teachers row, the
// programme-wide subjects only. STAFF (every other role) see the whole
// programme by default and may choose a district, or a zone in it.
//
// Takes the database as a parameter so the behaviour suite can run it.

import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { districts, rttSubjects, schools, teachers, zones } from "@gml/db/schema";
import type { Actor } from "@/lib/visibility";

type Db = NodePgDatabase<Record<string, unknown>>;

// lib/ids.ts's check, repeated because that module is server-only and this
// one, like lib/visibility.ts, is imported by the behaviour suite directly.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (raw: unknown): raw is string => typeof raw === "string" && UUID.test(raw);

/** A district, or one zone of it. */
export type Place = {
  districtId: string;
  districtName: string;
  zoneId: string | null;
  zoneName: string | null;
};

export type RttScope = {
  isAdmin: boolean;
  /** Everyone but a teacher: sees the whole programme, may choose a place. */
  isStaff: boolean;
  /** The place being shown; null means the whole programme. */
  place: Place | null;
  /** A teacher's current phase (teachers.current_phase_id), if set. */
  currentPhaseId: string | null;
  /** WHERE predicate on rtt_subjects; undefined means every subject. */
  subjectWhere: SQL | undefined;
};

const programmeWide = and(isNull(rttSubjects.districtId), isNull(rttSubjects.zoneId))!;

/** The subjects taught in `place`: the programme's, its district's, its zone's. */
function subjectsIn(place: Place): SQL {
  return or(
    programmeWide,
    eq(rttSubjects.districtId, place.districtId),
    place.zoneId
      ? eq(rttSubjects.zoneId, place.zoneId)
      : inArray(rttSubjects.zoneId, sql`(SELECT ${zones.id} FROM ${zones} WHERE ${zones.districtId} = ${place.districtId})`),
  )!;
}

/** A requested place, resolved; a zone names its own district. */
async function resolvePlace(db: Db, requested: { district?: string; zone?: string }): Promise<Place | null> {
  if (isUuid(requested.zone)) {
    const [z] = await db
      .select({ districtId: districts.id, districtName: districts.name, zoneId: zones.id, zoneName: zones.name })
      .from(zones)
      .innerJoin(districts, eq(districts.id, zones.districtId))
      .where(eq(zones.id, requested.zone))
      .limit(1);
    if (z) return z;
  }
  if (isUuid(requested.district)) {
    const [d] = await db
      .select({ districtId: districts.id, districtName: districts.name })
      .from(districts)
      .where(eq(districts.id, requested.district))
      .limit(1);
    if (d) return { ...d, zoneId: null, zoneName: null };
  }
  return null;
}

/**
 * The viewer's RTT scope. `requested` (?district= / ?zone=) is honoured for
 * staff only: a teacher is shown her own place whatever the URL says.
 */
export async function rttScope(
  db: Db,
  actor: Actor,
  requested: { district?: string; zone?: string } = {},
): Promise<RttScope> {
  const isAdmin = actor.role === "programme_admin" || actor.role === "super_admin";
  const isStaff = actor.role !== "teacher";
  const active = isAdmin ? undefined : eq(rttSubjects.active, true);

  if (isStaff) {
    const place = await resolvePlace(db, requested);
    return { isAdmin, isStaff, place, currentPhaseId: null, subjectWhere: and(active, place ? subjectsIn(place) : undefined) };
  }

  const [home] = await db
    .select({
      districtId: districts.id,
      districtName: districts.name,
      zoneId: zones.id,
      zoneName: zones.name,
      currentPhaseId: teachers.currentPhaseId,
    })
    .from(teachers)
    .innerJoin(schools, eq(schools.id, teachers.schoolId))
    .innerJoin(zones, eq(zones.id, schools.zoneId))
    .innerJoin(districts, eq(districts.id, zones.districtId))
    .where(eq(teachers.userId, actor.id))
    .limit(1);
  if (!home) {
    // No teacher record, so no place: what is taught everywhere.
    return { isAdmin, isStaff, place: null, currentPhaseId: null, subjectWhere: and(active, programmeWide) };
  }
  const { currentPhaseId, ...place } = home;
  return { isAdmin, isStaff, place, currentPhaseId, subjectWhere: and(active, subjectsIn(place)) };
}

/**
 * teachers.id predicate for a staff place filter: the teachers whose school
 * is in the place. Undefined for the whole programme.
 */
export function teachersIn(place: Place | null): SQL | undefined {
  if (!place) return undefined;
  const zoneIds = place.zoneId
    ? sql`(${place.zoneId}::uuid)`
    : sql`(SELECT ${zones.id} FROM ${zones} WHERE ${zones.districtId} = ${place.districtId})`;
  return inArray(teachers.schoolId, sql`(SELECT ${schools.id} FROM ${schools} WHERE ${schools.zoneId} IN ${zoneIds})`);
}

export type PlaceOption = { districtId: string; districtName: string; zones: Array<{ id: string; name: string }> };

/** Every district with its zones, for the staff picker. */
export async function placeOptions(db: Db): Promise<PlaceOption[]> {
  const rows = await db
    .select({ districtId: districts.id, districtName: districts.name, zoneId: zones.id, zoneName: zones.name })
    .from(districts)
    .leftJoin(zones, eq(zones.districtId, districts.id))
    .orderBy(asc(districts.name), asc(zones.name));
  const out: PlaceOption[] = [];
  for (const r of rows) {
    let d = out.find((o) => o.districtId === r.districtId);
    if (!d) out.push((d = { districtId: r.districtId, districtName: r.districtName, zones: [] }));
    if (r.zoneId && r.zoneName) d.zones.push({ id: r.zoneId, name: r.zoneName });
  }
  return out;
}

/** "Zone, District" or "District". */
export function placeLabel(place: Place): string {
  return place.zoneName ? `${place.zoneName}, ${place.districtName}` : place.districtName;
}
