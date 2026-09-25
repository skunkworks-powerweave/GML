// SCORM 1.2 packages and learner tracking (migration 0041).
//
// A package belongs to an RTT subject and is launched from that subject's
// page. Its files live in the private `scorm-packages` bucket (_post/009),
// one object per file under `<package id>/<n>`, and are served same-origin by
// /api/scorm/content/<package id>/<path> -- which looks the path up in
// scorm_package_files, so only a file the upload validated can ever be served,
// and no object key is derived from a name an archive chose.
//
// One scorm_attempts row per learner per package: SCORM 1.2 has a single
// learner record per SCO, resumed on every launch. apps/web/src/lib/scorm/
// store.ts writes it; the column vocabularies are lib/scorm/cmi.ts's.

import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { rttSubjects } from "./rtt";

export const scormPackages = pgTable(
  "scorm_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // RESTRICT, as every RTT content key is since 0031: a subject with
    // tracked learning under it is retired (active = false), not deleted.
    rttSubjectId: uuid("rtt_subject_id").notNull().references(() => rttSubjects.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 240 }).notNull(),
    manifestIdentifier: text("manifest_identifier").notNull().default(""),
    // The launch file (a path in scorm_package_files) and whatever followed
    // it in the manifest's href (?query / #fragment).
    launchPath: text("launch_path").notNull(),
    launchQuery: text("launch_query").notNull().default(""),
    // adlcp:masteryscore and adlcp:datafromlms, offered to the SCO as
    // cmi.student_data.mastery_score and cmi.launch_data.
    masteryScore: real("mastery_score"),
    launchData: text("launch_data"),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    // Hidden from learners when false; the rows and files are kept, because
    // learners' tracking hangs off them.
    active: boolean("active").notNull().default(true),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("scorm_packages_subject_idx").on(t.rttSubjectId)],
);

export const scormPackageFiles = pgTable(
  "scorm_package_files",
  {
    packageId: uuid("package_id").notNull().references(() => scormPackages.id, { onDelete: "cascade" }),
    // Package-relative, exactly as in the archive (lib/scorm/package.ts has
    // already refused anything that leaves the package).
    path: text("path").notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.packageId, t.path] })],
);

export const scormAttempts = pgTable(
  "scorm_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id").notNull().references(() => scormPackages.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    lessonStatus: varchar("lesson_status", { length: 16 }).notNull().default("not attempted"),
    lessonLocation: varchar("lesson_location", { length: 255 }).notNull().default(""),
    scoreRaw: real("score_raw"),
    scoreMin: real("score_min"),
    scoreMax: real("score_max"),
    suspendData: text("suspend_data").notNull().default(""),
    exit: varchar("exit", { length: 16 }).notNull().default(""),
    // Time, in centiseconds. total_time_cs is every EARLIER session;
    // session_time_cs is the latest report of session `session_id`, folded
    // into the total when a commit arrives from a different session -- so a
    // session that ends without LMSFinish (a closed tab, a dead battery) still
    // counts, once.
    totalTimeCs: bigint("total_time_cs", { mode: "number" }).notNull().default(0),
    sessionTimeCs: bigint("session_time_cs", { mode: "number" }).notNull().default(0),
    sessionId: uuid("session_id"),
    sessionCount: integer("session_count").notNull().default(0),
    firstLaunchedAt: timestamp("first_launched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // The first time the status became passed, completed or failed.
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("scorm_attempts_package_user_uq").on(t.packageId, t.userId),
    index("scorm_attempts_user_idx").on(t.userId),
    check(
      "scorm_attempts_lesson_status_check",
      sql`${t.lessonStatus} IN ('passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted')`,
    ),
    check("scorm_attempts_exit_check", sql`${t.exit} IN ('time-out', 'suspend', 'logout', '')`),
    check("scorm_attempts_suspend_data_len", sql`length(${t.suspendData}) <= 4096`),
    check(
      "scorm_attempts_score_range",
      sql`(${t.scoreRaw} IS NULL OR ${t.scoreRaw} BETWEEN 0 AND 100) AND (${t.scoreMin} IS NULL OR ${t.scoreMin} BETWEEN 0 AND 100) AND (${t.scoreMax} IS NULL OR ${t.scoreMax} BETWEEN 0 AND 100)`,
    ),
  ],
);

export type ScormPackage = typeof scormPackages.$inferSelect;
export type ScormPackageFile = typeof scormPackageFiles.$inferSelect;
export type ScormAttempt = typeof scormAttempts.$inferSelect;
