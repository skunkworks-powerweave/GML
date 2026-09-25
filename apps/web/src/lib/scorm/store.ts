// SCORM 1.2 persistence: packages, the files they may serve, and each
// learner's record (schema/scorm.ts, migration 0041).
//
// WHO MAY LAUNCH A PACKAGE is answered in exactly one place, launchableWhere:
// its subject must be one the viewer is shown (lib/rtt/scope.ts -- her place,
// and not retired) and the package must not be withdrawn, unless she is an
// administrator. The launch page, the content route and the commit route all
// ask through it, so a package cannot be reachable by one and not another.
//
// Takes the database as a parameter, like lib/rtt/*, so the behaviour suite
// runs it directly.

import { and, asc, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { phases, rttSubjects, scormAttempts, scormPackageFiles, scormPackages, terms, users } from "@gml/db/schema";
import type { Actor } from "@/lib/visibility";
import { rttScope } from "../rtt/scope";
import { FINISHED_STATUSES, STATUS_RANK, type CommitPayload, type LessonStatus } from "./cmi";

type Db = NodePgDatabase<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NewScormPackage = {
  id: string;
  rttSubjectId: string;
  title: string;
  manifestIdentifier: string;
  launchPath: string;
  launchQuery: string;
  masteryScore: number | null;
  launchData: string | null;
  uploadedByUserId: string | null;
  totalBytes: number;
  files: Array<{ path: string; objectKey: string; sizeBytes: number }>;
};

/** The package row and its file list, in one transaction. */
export async function insertPackage(db: Db, p: NewScormPackage): Promise<string> {
  await db.transaction(async (tx) => {
    await tx.insert(scormPackages).values({
      id: p.id,
      rttSubjectId: p.rttSubjectId,
      title: p.title,
      manifestIdentifier: p.manifestIdentifier,
      launchPath: p.launchPath,
      launchQuery: p.launchQuery,
      masteryScore: p.masteryScore,
      launchData: p.launchData,
      fileCount: p.files.length,
      totalBytes: p.totalBytes,
      uploadedByUserId: p.uploadedByUserId,
    });
    for (let i = 0; i < p.files.length; i += 500) {
      await tx.insert(scormPackageFiles).values(p.files.slice(i, i + 500).map((f) => ({ packageId: p.id, ...f })));
    }
  });
  return p.id;
}

/** Withdraw or restore a package. Returns its title, or null when there is no such package. */
export async function setPackageActive(db: Db, id: string, active: boolean): Promise<string | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db
    .update(scormPackages)
    .set({ active })
    .where(eq(scormPackages.id, id))
    .returning({ title: scormPackages.title });
  return row?.title ?? null;
}

/** WHERE over scorm_packages joined to rtt_subjects: the packages `viewer` may launch. */
async function launchableWhere(db: Db, viewer: Actor): Promise<SQL | undefined> {
  const scope = await rttScope(db, viewer);
  return and(scope.isAdmin ? undefined : eq(scormPackages.active, true), scope.subjectWhere);
}

export type LaunchablePackage = {
  id: string;
  title: string;
  rttSubjectId: string;
  subjectName: string;
  launchPath: string;
  launchQuery: string;
  masteryScore: number | null;
  launchData: string | null;
  active: boolean;
};

/** The package, if `viewer` may launch it; null otherwise (including a malformed id). */
export async function packageForViewer(db: Db, viewer: Actor, packageId: string): Promise<LaunchablePackage | null> {
  if (!UUID.test(packageId)) return null;
  const [row] = await db
    .select({
      id: scormPackages.id,
      title: scormPackages.title,
      rttSubjectId: scormPackages.rttSubjectId,
      subjectName: rttSubjects.name,
      launchPath: scormPackages.launchPath,
      launchQuery: scormPackages.launchQuery,
      masteryScore: scormPackages.masteryScore,
      launchData: scormPackages.launchData,
      active: scormPackages.active,
    })
    .from(scormPackages)
    .innerJoin(rttSubjects, eq(rttSubjects.id, scormPackages.rttSubjectId))
    .where(and(eq(scormPackages.id, packageId), await launchableWhere(db, viewer)))
    .limit(1);
  return row ?? null;
}

/**
 * The Storage key of one file of a package `viewer` may launch, by EXACT
 * path; null for anything else. Nothing is normalised: the upload stored
 * every path already validated, so a spelling that is not a row is not a file.
 */
export async function servableFile(
  db: Db,
  viewer: Actor,
  packageId: string,
  path: string,
): Promise<{ objectKey: string; sizeBytes: number } | null> {
  if (!UUID.test(packageId)) return null;
  const [row] = await db
    .select({ objectKey: scormPackageFiles.objectKey, sizeBytes: scormPackageFiles.sizeBytes })
    .from(scormPackageFiles)
    .innerJoin(scormPackages, eq(scormPackages.id, scormPackageFiles.packageId))
    .innerJoin(rttSubjects, eq(rttSubjects.id, scormPackages.rttSubjectId))
    .where(and(eq(scormPackageFiles.packageId, packageId), eq(scormPackageFiles.path, path), await launchableWhere(db, viewer)))
    .limit(1);
  return row ?? null;
}

/** What the runtime starts a session with (SCORM 1.2 RTE 3.4). */
export type LaunchState = {
  lessonStatus: LessonStatus;
  lessonLocation: string;
  scoreRaw: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  suspendData: string;
  /** cmi.core.total_time: every earlier session, in centiseconds. */
  totalTimeCs: number;
  /** cmi.core.entry. */
  entry: "ab-initio" | "resume" | "";
};

export async function launchState(db: Db, userId: string, packageId: string): Promise<LaunchState> {
  const [a] = await db
    .select()
    .from(scormAttempts)
    .where(and(eq(scormAttempts.packageId, packageId), eq(scormAttempts.userId, userId)))
    .limit(1);
  if (!a) {
    return { lessonStatus: "not attempted", lessonLocation: "", scoreRaw: null, scoreMin: null, scoreMax: null, suspendData: "", totalTimeCs: 0, entry: "ab-initio" };
  }
  const untouched = a.lessonStatus === "not attempted" && a.suspendData === "" && a.lessonLocation === "";
  return {
    lessonStatus: a.lessonStatus as LessonStatus,
    lessonLocation: a.lessonLocation,
    scoreRaw: a.scoreRaw,
    scoreMin: a.scoreMin,
    scoreMax: a.scoreMax,
    suspendData: a.suspendData,
    // The last session's time is folded into the total by the NEXT session's
    // first commit; until then it is still separate, and both are history.
    totalTimeCs: Number(a.totalTimeCs) + Number(a.sessionTimeCs),
    entry: a.exit === "suspend" ? "resume" : untouched ? "ab-initio" : "",
  };
}

const RANK = sql.raw(`ARRAY[${STATUS_RANK.map((s) => `'${s}'`).join(", ")}]::text[]`);
const excluded = (column: string) => sql.raw(`excluded."${column}"`);

/**
 * Record a commit (LMSCommit or LMSFinish) for `userId`, whoever the payload
 * claims to be: the learner is the signed-in user.
 *
 *   time     A commit from a NEW session folds the previous session's latest
 *            time into the total; a repeat commit of the same session replaces
 *            its time. So a session that never calls LMSFinish still counts,
 *            and none counts twice.
 *   status   A lower status (STATUS_RANK) never replaces a higher one, and the
 *            scores move with the status: the record is the learner's best
 *            outcome, so reopening a passed module to review it does not undo
 *            the pass in the staff view.
 *   the rest Location, suspend data and exit are always the latest -- that is
 *            what resuming needs.
 */
export async function commitAttempt(db: Db, userId: string, packageId: string, p: CommitPayload): Promise<void> {
  const better = sql`array_position(${RANK}, ${excluded("lesson_status")}::text) >= array_position(${RANK}, ${scormAttempts.lessonStatus}::text)`;
  const newSession = sql`${scormAttempts.sessionId} IS DISTINCT FROM ${excluded("session_id")}`;
  const keepBest = (column: string, current: AnyColumn) => sql`CASE WHEN ${better} THEN ${excluded(column)} ELSE ${current} END`;
  await db
    .insert(scormAttempts)
    .values({
      packageId,
      userId,
      lessonStatus: p.lessonStatus,
      lessonLocation: p.lessonLocation,
      scoreRaw: p.scoreRaw,
      scoreMin: p.scoreMin,
      scoreMax: p.scoreMax,
      suspendData: p.suspendData,
      exit: p.exit,
      sessionTimeCs: p.sessionTimeCs,
      sessionId: p.sessionId,
      sessionCount: 1,
      completedAt: FINISHED_STATUSES.has(p.lessonStatus) ? sql`now()` : null,
    })
    .onConflictDoUpdate({
      target: [scormAttempts.packageId, scormAttempts.userId],
      set: {
        lessonStatus: sql`CASE WHEN ${better} THEN ${excluded("lesson_status")} ELSE ${scormAttempts.lessonStatus} END`,
        scoreRaw: keepBest("score_raw", scormAttempts.scoreRaw),
        scoreMin: keepBest("score_min", scormAttempts.scoreMin),
        scoreMax: keepBest("score_max", scormAttempts.scoreMax),
        lessonLocation: excluded("lesson_location"),
        suspendData: excluded("suspend_data"),
        exit: excluded("exit"),
        totalTimeCs: sql`${scormAttempts.totalTimeCs} + CASE WHEN ${newSession} THEN ${scormAttempts.sessionTimeCs} ELSE 0 END`,
        sessionTimeCs: excluded("session_time_cs"),
        sessionId: excluded("session_id"),
        sessionCount: sql`${scormAttempts.sessionCount} + CASE WHEN ${newSession} THEN 1 ELSE 0 END`,
        completedAt: sql`COALESCE(${scormAttempts.completedAt}, ${excluded("completed_at")})`,
        updatedAt: sql`now()`,
      },
    });
}

export type TrackingRow = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  lessonStatus: LessonStatus;
  scoreRaw: number | null;
  totalTimeCs: number;
  sessionCount: number;
  completedAt: Date | null;
  updatedAt: Date;
};

/** Every learner's record for one package, for staff. */
export async function packageTracking(db: Db, packageId: string): Promise<TrackingRow[]> {
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      lessonStatus: scormAttempts.lessonStatus,
      scoreRaw: scormAttempts.scoreRaw,
      totalTimeCs: sql<string>`${scormAttempts.totalTimeCs} + ${scormAttempts.sessionTimeCs}`,
      sessionCount: scormAttempts.sessionCount,
      completedAt: scormAttempts.completedAt,
      updatedAt: scormAttempts.updatedAt,
    })
    .from(scormAttempts)
    .innerJoin(users, eq(users.id, scormAttempts.userId))
    .where(eq(scormAttempts.packageId, packageId))
    .orderBy(sql`${users.name} ASC NULLS LAST`, asc(users.email));
  return rows.map((r) => ({ ...r, lessonStatus: r.lessonStatus as LessonStatus, totalTimeCs: Number(r.totalTimeCs) }));
}

export type SubjectPackage = {
  id: string;
  title: string;
  active: boolean;
  lessonStatus: LessonStatus;
  scoreRaw: number | null;
  completedAt: Date | null;
};

/** The packages of one subject `viewer` may launch, with her own record of each. */
export async function subjectPackages(db: Db, viewer: Actor, subjectId: string): Promise<SubjectPackage[]> {
  const rows = await db
    .select({
      id: scormPackages.id,
      title: scormPackages.title,
      active: scormPackages.active,
      lessonStatus: sql<string>`COALESCE(${scormAttempts.lessonStatus}, 'not attempted')`,
      scoreRaw: scormAttempts.scoreRaw,
      completedAt: scormAttempts.completedAt,
    })
    .from(scormPackages)
    .innerJoin(rttSubjects, eq(rttSubjects.id, scormPackages.rttSubjectId))
    .leftJoin(scormAttempts, and(eq(scormAttempts.packageId, scormPackages.id), eq(scormAttempts.userId, viewer.id)))
    .where(and(eq(scormPackages.rttSubjectId, subjectId), await launchableWhere(db, viewer)))
    .orderBy(asc(scormPackages.createdAt), asc(scormPackages.title));
  return rows.map((r) => ({ ...r, lessonStatus: r.lessonStatus as LessonStatus }));
}

export type PackageSummary = {
  id: string;
  title: string;
  active: boolean;
  subject: string;
  rttSubjectId: string;
  fileCount: number;
  totalBytes: number;
  createdAt: Date;
  uploadedBy: string | null;
  learners: number;
  finished: number;
};

const summarySelect = {
  id: scormPackages.id,
  title: scormPackages.title,
  active: scormPackages.active,
  subject: sql<string>`${phases.label} || ' · ' || ${terms.name} || ' · ' || ${rttSubjects.name}`,
  rttSubjectId: scormPackages.rttSubjectId,
  fileCount: scormPackages.fileCount,
  totalBytes: scormPackages.totalBytes,
  createdAt: scormPackages.createdAt,
  uploadedBy: users.name,
  learners: sql<number>`(SELECT count(*)::int FROM ${scormAttempts} WHERE ${scormAttempts.packageId} = ${scormPackages.id})`,
  finished: sql<number>`(SELECT count(*)::int FROM ${scormAttempts} WHERE ${scormAttempts.packageId} = ${scormPackages.id} AND ${scormAttempts.completedAt} IS NOT NULL)`,
};

function summaries(db: Db) {
  return db
    .select(summarySelect)
    .from(scormPackages)
    .innerJoin(rttSubjects, eq(rttSubjects.id, scormPackages.rttSubjectId))
    .innerJoin(terms, eq(terms.id, rttSubjects.termId))
    .innerJoin(phases, eq(phases.id, terms.phaseId))
    .leftJoin(users, eq(users.id, scormPackages.uploadedByUserId));
}

/** Every package, newest first, with how many learners have a record and how many finished. For staff. */
export async function packageSummaries(db: Db): Promise<PackageSummary[]> {
  return summaries(db).orderBy(desc(scormPackages.createdAt));
}

/** One package's summary, or null. For staff; no scope applies. */
export async function packageSummary(db: Db, id: string): Promise<PackageSummary | null> {
  if (!UUID.test(id)) return null;
  const [row] = await summaries(db).where(eq(scormPackages.id, id)).limit(1);
  return row ?? null;
}
