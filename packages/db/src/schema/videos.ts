// Video pipeline schema — files, video_submissions, transcode_jobs.
// SM-3 enforcement: video originals (files.kind='video_original') cannot be
// deleted until a sibling files row with kind='hls_master', status='ready'
// exists AND a transcode_jobs row with status='succeeded' has verified_at set.
// Enforced at the SQL trigger layer + the app layer; the grep gate (spec 011)
// blocks `db.delete(files).where(files.kind='video_original')` regardless.

import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { videoSourceEnum, videoStatusEnum } from "./enums";
import { users } from "./identity";

/**
 * files — generic blob registry. video_submissions reference files by id.
 * Same table handles PDF/attachments later (spec 087+).
 */
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bucket: varchar("bucket", { length: 64 }).notNull(),
    objectKey: text("object_key").notNull(),
    mimeType: varchar("mime_type", { length: 80 }).notNull(),
    sizeBytes: integer("size_bytes"),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),
    originalFilename: text("original_filename"),
    // kind: video_original | hls_master | hls_segment | poster | pdf | attachment
    kind: varchar("kind", { length: 24 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("uploading"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("files_bucket_objectkey_uq").on(t.bucket, t.objectKey),
    index("files_kind_status_idx").on(t.kind, t.status),
    index("files_owner_idx").on(t.ownerUserId, t.createdAt),
    check(
      "files_kind_check",
      sql`${t.kind} IN ('video_original','hls_master','hls_segment','poster','pdf','attachment')`,
    ),
    check(
      "files_status_check",
      sql`${t.status} IN ('uploading','stored','failed','quarantined')`,
    ),
  ],
);

/**
 * video_submissions — one row per teaching video, regardless of source.
 * `context_type` + `context_id` link the video to its parent entity
 * (observation_cycle | teach_back | mentor_meeting | mentee_quarterly |
 * classroom_session | generic).
 */
export const videoSubmissions = pgTable(
  "video_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    hlsMasterKey: text("hls_master_key"),
    posterKey: text("poster_key"),
    source: videoSourceEnum("source").notNull(),
    externalUrl: text("external_url"),
    status: videoStatusEnum("status").notNull().default("received"),
    durationSec: integer("duration_sec"),
    width: integer("width"),
    height: integer("height"),
    processingLog: text("processing_log"),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    // Review is its own state, NOT a value of `status`. Folding it into the
    // pipeline enum meant marking a teach-back reviewed set status='reviewed',
    // and the player only renders when status='ready' -- so reviewing a video
    // permanently destroyed playback. See migration 0022.
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    contextType: varchar("context_type", { length: 32 }).notNull(),
    contextId: uuid("context_id"),
    // Migration 0042. Which quarter a 'mentee_quarterly' video is for: 1 (the
    // baseline) or 4 (the endline). NULL for every other context. Chosen when
    // the upload is reserved, so it is on the row that the completion call and
    // the reconciler both finish from.
    contextQuarter: smallint("context_quarter"),
    captionRaw: text("caption_raw"), // raw WhatsApp caption (when source='whatsapp')
    // Spec 144 — Meta's webhook delivers the same wa_message_id 2-3 times during
    // their at-least-once retry policy. We dedupe by storing the wa message_id
    // here and enforcing a partial UNIQUE index (WHERE NOT NULL) at the DB layer.
    // The webhook also pre-checks SELECT WHERE whatsapp_message_id = msg.id
    // and short-circuits to a 200 with audit 'whatsapp.message.replay_ignored'
    // so Meta stops retrying. Nullable: non-whatsapp submissions (tusd upload,
    // external_url) carry NULL and are exempt from the partial unique index.
    whatsappMessageId: text("whatsapp_message_id"),
    // Migration 0036. The Graph media id, so a failed fetch can be queued again
    // (Meta keeps the media ~30 days), and the sender's number as Meta sent it,
    // which the ingest log shows. Both null for non-WhatsApp rows.
    whatsappMediaId: text("whatsapp_media_id"),
    whatsappFrom: text("whatsapp_from"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("video_submissions_context_idx").on(t.contextType, t.contextId),
    // NOT NULL FK joined by the DLQ view and by upload completion.
    index("video_submissions_file_idx").on(t.fileId),
    index("video_submissions_submitter_idx").on(t.submittedByUserId, t.createdAt),
    index("video_submissions_status_idx").on(t.status, t.createdAt),
    // The teach-back review queue: only unreviewed rows. Migration 0022;
    // declared so the snapshot describes the database (F107).
    index("video_submissions_pending_review_idx")
      .on(t.contextType, t.createdAt)
      .where(sql`${t.reviewedAt} IS NULL`),
    // Spec 144 — partial unique index for WhatsApp idempotency. Only enforced
    // when whatsapp_message_id IS NOT NULL so other ingest sources are exempt.
    uniqueIndex("video_submissions_whatsapp_message_id_uq")
      .on(t.whatsappMessageId)
      .where(sql`${t.whatsappMessageId} IS NOT NULL`),
    check(
      "video_submissions_context_type_check",
      sql`${t.contextType} IN ('observation_cycle','teach_back','mentor_meeting','mentee_quarterly','classroom_session','generic')`,
    ),
    check(
      "video_submissions_context_quarter_check",
      sql`${t.contextQuarter} IS NULL OR (${t.contextType} = 'mentee_quarterly' AND ${t.contextQuarter} IN (1, 4))`,
    ),
    // SM-3 anchor: status='ready' requires hls_master_key non-null AND verified_at non-null
    check(
      "video_submissions_ready_requires_hls_check",
      sql`${t.status} <> 'ready' OR (${t.hlsMasterKey} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * transcode_jobs — one row per BullMQ worker run on a video_submission.
 * `profile` is "480p" (only Tier-0 rendition; 720p dropped per session-5 MSS).
 */
export const transcodeJobs = pgTable(
  "transcode_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    videoSubmissionId: uuid("video_submission_id")
      .notNull()
      .references(() => videoSubmissions.id, { onDelete: "cascade" }),
    profile: varchar("profile", { length: 8 }).notNull(), // 480p (720p dropped)
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("transcode_jobs_video_idx").on(t.videoSubmissionId),
    index("transcode_jobs_status_idx").on(t.status, t.createdAt),
    // Spec 143 — tightened to ONLY 480p. 720p was dropped in spec 041 (SM-4 / Tier-0 only)
    // but the CHECK at this level was left permissive. A bug in the BullMQ worker or a
    // hand-written test fixture could have written 'profile=720p' and the DB would have
    // accepted it silently, contradicting the documented anti-download / single-rendition
    // contract. The 0016 migration drops the old constraint and re-adds the tightened one.
    check(
      "transcode_jobs_profile_check",
      sql`${t.profile} IN ('480p')`,
    ),
    // Spec 162 — Adds 'dropped' as a terminal status used by the /admin/transcode-jobs
    // DLQ-admin view. 'dropped' means an operator looked at a permanently
    // failed job and decided NOT to retry it (e.g. the source video was
    // unusable / corrupted / off-topic). This is a manual operator decision
    // distinct from 'failed' (BullMQ ran out of retries) and 'cancelled'
    // (programmatic abort): once 'dropped', the job is excluded from retry
    // queries and the BullMQ DLQ entry is removed alongside.
    check(
      "transcode_jobs_status_check",
      sql`${t.status} IN ('queued','running','succeeded','failed','cancelled','dropped')`,
    ),
  ],
);

export type File = typeof files.$inferSelect;
export type VideoSubmission = typeof videoSubmissions.$inferSelect;
export type TranscodeJob = typeof transcodeJobs.$inferSelect;
