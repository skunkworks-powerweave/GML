# Audit action taxonomy

`audit_log.action` is a `varchar(64) NOT NULL` column. Values follow a
documented dotted-notation convention so reads of the audit log are
scannable and groupable by prefix.

**Format**: `/^[a-z_]+(\.[a-z_]+)*$/` — lowercase letters and
underscores, optional dotted segments.

This file is the **canonical taxonomy**. Every value passed to
`recordAudit({ action: "..." })` anywhere in the codebase MUST appear
in one of the prefix sections below. Adding a new action without
documenting it here is a governance violation; the run-16 audit
closure (spec 171) sweeps the source tree to produce this list. If
you add a row, append it to the matching prefix table and bump the
prefix's source-of-truth bullet under "Substrate moats" if applicable.

## Format conventions

- **Prefix family**: lowercase noun (`auth`, `gate`, `whatsapp`, ...).
  Roughly one per top-level domain object.
- **Sub-segments** (`.something.deeper`): from broad to narrow.
  `whatsapp.message.received` is broader than
  `whatsapp.message.replay_ignored`.
- **Verbs vs nouns**: lifecycle events use past-tense verbs
  (`enqueued`, `received`, `completed`, `dropped`, `rotated`).
  Pure surface-load events use the noun `surface_viewed` (or
  the generic `view`).

## auth.* — sign-in, sign-out, passwords

Sessions are Supabase Auth's. These rows are written by the application at
the points it takes part (`app/login/**`, `app/auth/**`, `auth.ts`,
`/settings`); `ip` is masked as everywhere else. `last_seen_at` on the user
is stamped with every `auth.sign_in`, which is what `/admin/users` shows.

| Action | Fires when | Metadata captured |
|---|---|---|
| `auth.sign_in` | A session was established: a password sign-in at `/login`, or an emailed link opened at `/auth/confirm` or `/auth/callback`. `user_id` and `entity_id` are the account | `method` ("password" / "email_link" / "recovery_link") |
| `auth.sign_in_failed` | A password sign-in reached the credential check and was refused. Throttled and outage-refused attempts write nothing, so this is bounded by the sign-in throttle. `user_id` is null: no account is looked up for a failure, and the attempt is not credited to anyone already signed in on that browser (a failed attempt leaves that session in place; `recordAudit({ userId: null })` skips the session fallback) | `reason` ("invalid_credentials" / "inactive" / "email_not_confirmed"), `emailHash` (first 16 hex characters of SHA-256 over the lower-cased address, never the address itself) |
| `auth.sign_out` | Someone signed out of this browser (other devices stay signed in) | none |
| `auth.password.changed` | The holder changed their own password at `/settings`, after re-entering the current one | `selfService` (true), `otherSessionsEnded` (true only when Supabase accepted the sign-out of the holder's other sessions) |
| `auth.password.reset_completed` | A new password was set at `/login/reset`, from a session an emailed recovery or magic link established in the last 15 minutes | `otherSessionsEnded` (as above) |

There is no per-account lockout any more, and so no lockout, unlock or
"rate limit down" rows: sign-in is throttled per account and address
(`auth.ts`), and a throttled attempt is simply refused. Requests for a reset or
magic link (`/login/forgot`) are not audited — the form answers identically for
known and unknown addresses, and a row per request would be a log any stranger
can fill. Token refreshes are not audited.

## admin.user.* — account administration (`/admin/users`)

`user_id` is the administrator, `entity_id` the account acted on. No password
is ever recorded, in any form. `sessionsEnded` is true only when the account's
sessions really were ended, and `sessionsEndedCount` then says how many.
`banApplied` and `banLifted` likewise record whether Supabase actually
applied or lifted the sign-in ban.

| Action | Fires when | Metadata captured |
|---|---|---|
| `admin.user.create` | An administrator created an account (with an initial password the holder must replace at first sign-in) | `email`, `role`, `linkKind` ("teacher" / "mentor" / null) |
| `admin.user.role_change` | An account's role was changed. Losing an administrator role ends the account's sessions | `from`, `to`, `sessionsEnded`, `sessionsEndedCount` |
| `admin.user.deactivate` | An account was deactivated: profile inactive, sessions ended, sign-in banned | `role`, `sessionsEnded`, `sessionsEndedCount`, `banApplied` |
| `admin.user.activate` | An account was reactivated (its old sessions stay ended) | `role`, `banLifted` |
| `admin.user.password_set` | An administrator set an account's password (the holder must replace it) | `role`, `sessionsEnded`, `sessionsEndedCount` |
| `admin.user.phone_set` | An administrator recorded or changed an account's WhatsApp number (the list `/admin/gates` shares a rotated section password with). The only `admin.user.*` action an administrator may take on their own account, so `user_id` can equal `entity_id` | none: the number itself is not recorded |
| `admin.user.phone_cleared` | An administrator removed an account's WhatsApp number | none |
| `admin.user.surface_viewed` | `/admin/users`, which lists every account's email address, was rendered (SM-9 visibility) | none |
| `admin.user.super_admin_bootstrapped` | The seed's `SUPER_ADMIN_*` bootstrap (`packages/db/src/scripts/seed.ts`, run by every deploy) created or promoted the first active `super_admin`, because none existed. The only grant of super_admin made without a super_admin, so `user_id` is null (no actor); `entity_id` is the account. Written in the same transaction as the promotion | `source` ("seed"), `authUserCreated`, `profileCreated` |

## gate.* — section password flow

| Action | Fires when | Metadata captured |
|---|---|---|
| `gate.attempt.success` | Learner submitted the correct section password on `/gate/[slug]` | `slug`, `userId`, `ipMasked` |
| `gate.attempt.fail` | Learner submitted an incorrect section password — either form-level (no slug match) or password-level (wrong hash) | `slug`, `reason` ("unknown_slug" / "bad_password"), `attemptCountInWindow` |
| `gate.rate_limit.redis_down` | Per-IP gate rate-limit threw; the endpoint fails-CLOSED — caller treated as denied | `slug`, `ipMasked`, truncated `error` string |
| `gate.password.rotated` | Admin minted a new section password on `/admin/gates` (spec 115 / 148); previous password is hashed-archived and immediately invalidated | `slug`, `actorId`, `archivedAt` |
| `gate.password.share_initiated` | Admin pressed "share via WhatsApp" on the gates page; the share-sheet was opened (no proof the message was actually sent, only that the affordance was clicked) | `slug`, `actorId`, `channel` ("whatsapp") |
| `gate.password.surface_viewed` | The `/admin/gates` page was rendered (SM-1 visibility into who's been browsing the password vault) | `actorId` |

## form.* — feedback-form runner + admin

| Action | Fires when | Metadata captured |
|---|---|---|
| `form.submit` | A learner / mentor submitted a feedback form via `/forms/[slug]` | `slug`, `userId`, `submissionId`, `fieldCount` |
| `form.schema.update` | A `super_admin` saved a new JSON schema on `/admin/forms/[id]` | `formId`, `actorId`, `version` |
| `form.access.denied` | A user attempted to load a form their role is not entitled to fill (spec 155) | `slug`, `userId`, `userRole`, `requiredRole` |
| `form.draft.save` | The autosave-on-blur ticker wrote an in-progress form to `form_drafts` | `formId`, `userId`, `bytes` |
| `form.draft.clear` | The user cleared their in-progress draft (or it was implicitly cleared by a successful submit) | `formId`, `userId`, `reason` ("user_cleared" / "submit_succeeded") |
| `form.config_error.both_handlers` | The form schema declares both a `onSubmit` and `onChange` handler with overlapping side-effects — a defensive log emitted when the runtime detects the ambiguous config and falls back to `onSubmit` only | `slug`, `version` |

## quiz.* — quiz runner + admin

| Action | Fires when | Metadata captured |
|---|---|---|
| `quiz.created` | A `programme_admin` or `super_admin` created a quiz on `/admin/quizzes` (it starts inactive, with no questions). `entity_type` `quizzes`, `entity_id` the quiz id, `user_id` the admin | `slug`, `title`, `passThreshold`, `rttSubjectId` |
| `quiz.schema.update` | A `programme_admin` or `super_admin` saved the JSON editor on `/admin/quizzes/[id]`. `entity_type` `quizzes`, `entity_id` the quiz id, `user_id` the admin. A setting's key is present when the save's payload set that field, whether or not its value changed: the editor pre-fills every setting from the stored quiz, so an ordinary save writes them all. To see what a save changed, compare with the quiz's previous row | `questionCount`, `questionsReplaced` (boolean: whether the save carried a questions array); when the payload carried them, `title`, `passThreshold`, `timeLimitSeconds` (null = untimed), `maxAttempts` (null = unlimited), `rttSubjectId`, `active` |
| `quiz.submit` | A learner's attempt was scored via `/quizzes/[slug]`. Graded server-side against the quiz's questions (spec 146); the `quiz_submissions` row is written in the same transaction that closes the learner's open `quiz_attempts` row. `entity_type` `quiz_submission`, `entity_id` the submission id, `user_id` the learner | `quizSlug`, `score` (percent), `passed` (boolean), `questionCount`, `answeredCount` |
| `quiz.attempt.expired` | A submission arrived after the quiz's time limit plus the 30 s grace, or the learner opened `/quizzes/[slug]` after that point with the attempt still open (the page closes it instead of mounting a runner with no time left); the attempt was closed and nothing was scored. `entity_type` `quizzes`, as the admin rows above (older rows carry `quiz`, the singular it was written with before; audit_log is append-only, so an export filtered by entity type needs both for them), `entity_id` the quiz id, `user_id` the learner | `quizSlug`, `limitSeconds` |

## scorm.* — SCORM 1.2 packages (`/admin/scorm`, `/scorm/[id]`)

| Action | Fires when | Metadata captured |
|---|---|---|
| `scorm.package.upload` | A `super_admin` uploaded a SCORM 1.2 package through `POST /api/scorm/packages` (the upload form on `/admin/scorm`) and every file of it was validated and stored. Refused uploads store nothing and are not audited. `entity_type` `scorm_package`, `entity_id` the new package id, `user_id` the super_admin | `title`, `rttSubjectId`, `fileCount`, `totalBytes` |
| `scorm.package.deactivate` | A `programme_admin` or `super_admin` withdrew a package from learners on `/admin/scorm/[id]`. Its files and every learner's record are kept. `entity_type` `scorm_package`, `entity_id` the package id, `user_id` the admin | `title` |
| `scorm.package.activate` | A `programme_admin` or `super_admin` restored a withdrawn package on `/admin/scorm/[id]`. `entity_type` `scorm_package`, `entity_id` the package id, `user_id` the admin | `title` |
| `scorm.attempt.finish` | A learner's SCO called `LMSFinish` and its final commit reached `POST /api/scorm/attempts/[id]`. The many `LMSCommit`s of a session are not audited. The values are what the SCO REPORTED; the stored record keeps the learner's best status (`lib/scorm/store.ts`). `entity_type` `scorm_package`, `entity_id` the package id, `user_id` the learner | `lessonStatus`, `scoreRaw` (0-100 or null), `sessionTimeCs` (centiseconds) |

## whatsapp.* — webhook ingest pipeline

The webhook (`apps/web/src/app/api/webhooks/whatsapp/route.ts`) records each video and queues its media fetch before it answers Meta; the worker (`apps/worker/src/whatsapp-fetch.ts`) fetches the media, queues the transcode and replies to the sender. Worker rows carry no `user_id` or `ip`: there is no request. `/admin/whatsapp-log` lists every WhatsApp submission, including ones still waiting for or refused by the fetch, with the reason. These rows are what this table says they are, checked by `tests/behaviour/whatsapp-observability.test.ts`.

| Action | Fires when | Metadata captured |
|---|---|---|
| `whatsapp.signature_failed` | A POST to the configured webhook failed the HMAC-SHA256 check against `WHATSAPP_APP_SECRET`, or carried no signature; the answer is 401. `entity_type` `webhook`. Written at most 5 times per masked source per minute, and at most 30 times a minute from all sources together per app process (the table is append-only and the endpoint is public), each time with a log line naming `WHATSAPP_APP_SECRET` when a signature was offered. Not written while the secret is unset (503 `whatsapp_not_configured`) | `ipMasked` (/24 or /64), `signatureProvided` (boolean) |
| `whatsapp.message.received` | A signed message carrying a video (a video message, or a document with a `video/*` mime type) was accepted, before the submission is written. `entity_type` `video_submission`, no `entity_id` | `msgId`, `type` ("video" / "document"), `mediaId` (Graph media id), `mime`, `caption`, `from` (sender, E.164 digits), `to` (the programme number) |
| `whatsapp.message.replay_ignored` | Meta redelivered a message that already has a submission, so nothing was done. `entity_type` `video_submission`; `entity_id` the existing submission when the pre-check found it | `msgId`, `from`, `to`; or, when a concurrent delivery won the insert, `msgId`, `reason` ("insert_conflict") |
| `whatsapp.message.ignored` | A signed message that is not a video (text, image, audio, a PDF document, ...) arrived; it is not ingested. Text / image / audio / sticker / document senders are queued a reply saying what the number accepts, and an `unsupported` message (one Meta could not deliver) a reply saying how to send the video; at most one of each per sender per 10 minutes, so an auto-replying number cannot start a loop. `entity_type` `webhook` | `msgId`, `type`, `mime` (documents only, else null), `from`, `to` |
| `whatsapp.payload.unrecognised` | A correctly signed delivery, or one message in it, did not have the shape this code reads (Meta's schema moved); it was skipped and answered 200, because a retry cannot make it readable. The rest of the batch is still processed. `entity_type` `webhook` | `bytes` (body size), `where` ("payload" / "message[<index>]"), `path` (where the shape broke) |
| `whatsapp.context.unmatched` | The caption named no target that exists, so the video is kept as `generic`. `entity_type` `video_submission` | `msgId`, `caption`, `reason` ("no_prefix_match" / "observation_cycle.code_not_found" / "teach_back.invalid_uuid" / "teach_back.subject_not_found" / "mentor_meeting.invalid_uuid" / "mentor_meeting.id_not_found" / "mentee_quarterly.invalid_uuid" / "mentee_quarterly.pairing_not_found") |
| `whatsapp.context.forbidden` | The caption named a real target the sender may not attach to (not the cycle's teacher, observer, paired mentor or an admin; not a member of the meeting's or quarterly video's pairing; a signed-off cycle; a Q4 video before the pairing's last quarter; a teach-back for an RTT subject the sender is not shown), or the number matches no registered user; the video is kept as `generic`. `entity_type` `video_submission` | `msgId`, `caption`, `from`, `senderUserId` (null when unregistered), `attemptedContextType`, `attemptedContextId`, `attemptedQuarter` (quarterly videos only), `reason` ("sender_unregistered" / "no_target" / "observation_cycle.not_permitted" / "observation_cycle.signed_off" / "mentor_meeting.not_permitted" / "mentee_quarterly.not_permitted" / "mentee_quarterly.q4_not_open" / "teach_back.not_permitted") |
| `whatsapp.fetch.enqueued` | The submission (status `received`, file `uploading`) and its media-fetch job were written in one transaction, before Meta got its 200. `entity_type` `video_submission`, `entity_id` the submission | `msgId`, `mediaId`, `jobId`, `contextType` |
| `whatsapp.media.fetched` | Worker: the media was downloaded from Meta and stored, the submission moved to `queued` and its transcode queued. `entity_type` `video_submission`, `entity_id` the submission | `msgId`, `bytes`, `attempt` |
| `whatsapp.media.checksum_mismatch` | Worker: the downloaded bytes' SHA-256 differs from the checksum in Meta's payload. Reported, not enforced (the stored file's checksum is the computed one). `entity_type` `video_submission` | `msgId`, `claimed`, `computed` |
| `whatsapp.media.fetch_failed` | Worker: the LAST attempt failed (or the worker died during it and the lease reaper dead-lettered the fetch, or a refusal no retry can change -- media over the size cap -- ended it at once), so the submission and its file are now `failed` with the reason in `processing_log` (earlier attempts are in the job's `last_error`, shown on `/admin/whatsapp-log`). `entity_type` `video_submission` | `msgId`, `attempts`, `error` (names the cause: a missing `WHATSAPP_ACCESS_TOKEN`, the HTTP status and Graph error code, a non-video body, the size cap, a Storage refusal) |
| `whatsapp.reply.sent` | Worker: the sender was told the outcome through the Cloud API. `entity_type` `video_submission` | `msgId`, `kind` ("linked_cycle" / "linked_teach_back" / "linked_meeting" / "linked_quarterly" / "unmatched" / "unregistered" / "fetch_failed") |
| `whatsapp.reply.failed` | Worker: Meta refused the reply, or it could not be sent. Not written while replies are not configured (`WHATSAPP_PHONE_NUMBER_ID` or `WHATSAPP_ACCESS_TOKEN` unset; the worker logs that once). `entity_type` `video_submission` | `msgId`, `kind`, `reason` |
| `whatsapp.log.surface_viewed` | The `/admin/whatsapp-log` page rendered (SM-1 visibility). `entity_type` `video_submission`, `user_id` the admin | `parsing` (the filter, "any" when unset), `from`, `to` (the date filters, or null) |
| `whatsapp.transcode.resent` | An admin pressed "Resend transcode" on `/admin/whatsapp-log` for a submission whose media is stored; the transcode was queued again. `entity_type` `video_submission`, `entity_id` the submission, `user_id` the admin | `previousStatus`, `bucket`, `objectKey` |
| `whatsapp.fetch.retried` | An admin pressed "Retry fetch" on `/admin/whatsapp-log` for a submission whose media never arrived; the fetch was queued again from the kept media id (or a waiting one moved to the front). `entity_type` `video_submission`, `entity_id` the submission, `user_id` the admin | `previousStatus`, `msgId`, `mediaId`, `jobId`, `deduped` (boolean) |

## transcode.* — BullMQ + ffmpeg pipeline

| Action | Fires when | Metadata captured |
|---|---|---|
| `transcode.enqueued` | A new `video_submissions` row was inserted (from upload OR WhatsApp) and a job was placed on the `transcode` BullMQ queue | `submissionId`, `source` ("upload" / "whatsapp"), `bytes` |
| `transcode.retry_requested` | An admin pressed "Retry" on `/admin/transcode-jobs` for a stuck submission (spec 162) | `submissionId`, `actorId`, `previousFailureReason` |
| `transcode.dropped` | An admin pressed "Drop" on `/admin/transcode-jobs`; the submission is now terminal and will not be retried | `submissionId`, `actorId` |
| `transcode.dlq.surface_viewed` | The `/admin/transcode-jobs` page rendered (SM-1 visibility) | `actorId` |

## admin.row.* — generic admin CRUD (spec 014 / 114 / 152)

| Action | Fires when | Metadata captured |
|---|---|---|
| `admin.row.create` | A new row was inserted via the generic `/admin/data/[entity]` runner | `entity`, `rowId`, `actorId`, `payloadKeys` (array of changed field names) |
| `admin.row.update` | A row was updated via `/admin/data/[entity]` | `entity`, `rowId`, `actorId`, `changedKeys` |
| `admin.row.delete` | A single row was deleted (soft or hard, depending on the entity) | `entity`, `rowId`, `actorId` |
| `admin.row.bulk_delete` | The bulk-select + delete affordance on a grid page deleted N rows in one transaction (spec 157) | `entity`, `actorId`, `rowIds` (array), `count` |

## grading_scales.* / grading_bands.* / observation_rubrics.* / rubric_criteria.* / teacher_classes.* / assessments.* / quizzes.* / approvals.* / account_requests.* — the teaching-records data tables' CSV

The data tables added for teaching records (`/admin/data/<slug>`, `apps/web/src/admin/entities/`) write their rows through `admin.row.*` above; their CSV import and export are audited per table, under the entity's `auditName` where its slug has a hyphen (`grading-scales` -> `grading_scales`). `entity_type` is the slug, `user_id` the administrator (`programme_admin` or `super_admin`). The students' attendance and marks tables are under `learners.*` below (SM-9). `approvals` and `account-requests` are read-only lists: they export, and every write, the import included, is refused.

| Action | Fires when | Metadata captured |
|---|---|---|
| `grading_scales.bulk_import` | A grade-scales CSV was imported (`/api/admin/data/grading-scales/import`); an `id` column updates those rows. `entity_type` `grading-scales` | `inserted`, `updated`, `skipped`, `updates` (per updated row, `changes` from/to), `updatesTruncated` (only past 200 updates) |
| `grading_bands.bulk_import` | A grade-bands CSV was imported. `entity_type` `grading-bands` | `inserted`, `updated`, `skipped`, `updates`, `updatesTruncated` |
| `observation_rubrics.bulk_import` | An observation-rubrics CSV was imported. `entity_type` `observation-rubrics` | `inserted`, `updated`, `skipped`, `updates`, `updatesTruncated` |
| `rubric_criteria.bulk_import` | A rubric-criteria CSV was imported. `entity_type` `rubric-criteria` | `inserted`, `updated`, `skipped`, `updates`, `updatesTruncated` |
| `teacher_classes.bulk_import` | A teachers' classes CSV was imported. `entity_type` `teacher-classes` | `inserted`, `updated`, `skipped`, `updates`, `updatesTruncated` |
| `assessments.bulk_import` | A tests CSV was imported. `entity_type` `assessments` | `inserted`, `updated`, `skipped`, `updates`, `updatesTruncated` |
| `quizzes.bulk_import` | A quizzes (settings) CSV was imported. `entity_type` `quizzes` | `inserted`, `updated`, `skipped`, `updates`, `updatesTruncated` |
| `grading_scales.bulk_export` | The grade-scales CSV was downloaded (`/api/admin/data/grading-scales/export`). `entity_type` `grading-scales` | `rowCount`, `filename`, `truncated` |
| `grading_bands.bulk_export` | The grade-bands CSV was downloaded. `entity_type` `grading-bands` | `rowCount`, `filename`, `truncated` |
| `observation_rubrics.bulk_export` | The observation-rubrics CSV was downloaded. `entity_type` `observation-rubrics` | `rowCount`, `filename`, `truncated` |
| `rubric_criteria.bulk_export` | The rubric-criteria CSV was downloaded. `entity_type` `rubric-criteria` | `rowCount`, `filename`, `truncated` |
| `teacher_classes.bulk_export` | The teachers' classes CSV was downloaded. `entity_type` `teacher-classes` | `rowCount`, `filename`, `truncated` |
| `assessments.bulk_export` | The tests CSV was downloaded. `entity_type` `assessments` | `rowCount`, `filename`, `truncated` |
| `quizzes.bulk_export` | The quizzes (settings) CSV was downloaded. `entity_type` `quizzes` | `rowCount`, `filename`, `truncated` |
| `approvals.bulk_export` | The approvals history CSV was downloaded (`/api/admin/data/approvals/export`). `entity_type` `approvals` | `rowCount`, `filename`, `truncated` |
| `account_requests.bulk_export` | The account-requests CSV (names, addresses and phone numbers of applicants) was downloaded. `entity_type` `account-requests` | `rowCount`, `filename`, `truncated` |

## learners.* / mentors.* — SM-9 PII reads and bulk exports

| Action | Fires when | Metadata captured |
|---|---|---|
| `learners.view` | A single class's learners list was rendered on `/repo/class/[id]/learners` (SM-9 — every learner-PII read writes an audit row), by a `programme_admin` / `super_admin`, or by a teacher for a class she teaches (her own students only; any other class answers 404 and writes nothing). `entity_type` `class`, `entity_id` the class, `user_id` the reader | `route`, `schoolId`, `grade` |
| `learners.bulk_view` | The all-learners surface `/repo/students` rendered (multi-class scan) — for a teacher, her own students only. `entity_type` `all`, `user_id` the reader | `piiAudited`, `rowCount`, `page`, `schoolFilter`, `qFilter` |
| `learners.search` | `/repo/students` rendered with a name search (`?q=`); one row per reader, search and hour (deduplicated), beside that render's `learners.bulk_view` | `q`, `resultCount`, `__dedupKey` (the reader and search it deduplicates on) |
| `learners.bulk_export` | A `super_admin` downloaded the learners CSV via `/api/admin/learners/export` (SM-9 bulk-export gate) | `actorId`, `rowCount`, `filterApplied` |
| `mentors.bulk_export` | A `super_admin` downloaded the mentors CSV via `/api/admin/data/mentors/export` (spec 160) | `actorId`, `rowCount`, `filterApplied` |
| `session_attendance.view` | The students' attendance data table `/admin/data/session-attendance` rendered (SM-9: its rows and pickers name children). `entity_type` `session-attendance`, `user_id` the reader | `rowCount`, `page`, `filters` (the filters applied), `skippedFilters` (those that could not apply) |
| `assessment_marks.view` | The students' marks data table `/admin/data/assessment-marks` rendered (SM-9). `entity_type` `assessment-marks`, `user_id` the reader | `rowCount`, `page`, `filters`, `skippedFilters` |
| `session_attendance.bulk_export` | A `programme_admin` or `super_admin` downloaded the students' attendance CSV (`/api/admin/data/session-attendance/export`). `entity_type` `session-attendance` | `rowCount`, `filename`, `truncated` |
| `assessment_marks.bulk_export` | A `programme_admin` or `super_admin` downloaded the students' marks CSV (`/api/admin/data/assessment-marks/export`). `entity_type` `assessment-marks` | `rowCount`, `filename`, `truncated` |
| `session_attendance.bulk_import` | A `programme_admin` or `super_admin` imported a students' attendance CSV; every row it adds or updates is stamped with the importer as `marked_by`. `entity_type` `session-attendance` | `inserted`, `updated`, `skipped`, `updates` (field names changed per updated row, never values), `updatesTruncated` (only past 200 updates) |
| `assessment_marks.bulk_import` | A `programme_admin` or `super_admin` imported a students' marks CSV. `entity_type` `assessment-marks` | `inserted`, `updated`, `skipped`, `updates` (field names changed per updated row), `updatesTruncated` (only past 200 updates) |

## resource.* / video.* — media playback

| Action | Fires when | Metadata captured |
|---|---|---|
| `resource.pdf.view` | A PDF resource was opened: written when `/repo/resource/[id]/view` renders (spec 087), and again by `/api/media/pdf/[id]` each time the viewer fetches the file, before any byte is sent. `entity_type` `resource`, `entity_id` the resource id, `user_id` the viewer. The viewer's in-browser confirmation is its own action, `resource.view.client_ping` | `kind` (the resource's kind), `fileKey` (its Storage object key), `piiAudited` (false; the page render only) |
| `resource.pdf.uploaded` | A `programme_admin` or `super_admin` uploaded a PDF from a resource's form in the data tables (`POST /api/admin/data/resources/upload`); it was checked (a whole PDF, at most 9 MiB) and stored in the `pdfs` bucket the viewer reads. The row the key is saved into is audited separately, as `admin.row.create` / `admin.row.update`, when the form is saved. Refused uploads store nothing and write nothing. `entity_type` `resource`, no `entity_id` (the row may not exist yet), `user_id` the admin | `fileKey` (the new Storage object key), `bytes`, `field` (the form field, `fileKey`) |
| `resource.view.client_ping` | PdfViewer's one keepalive POST to `/api/audit/resource-view` when it first paints a document (spec 099): the viewer really rendered it, as against a page that rendered on the server and never loaded. `entity_type` `resource`, `entity_id` the resource id (not looked up), `user_id` the session user, never a viewer the client names. At most 30 per user per minute: over that the POST is refused with 429 and writes nothing, and nothing is written while the limiter is unavailable (503) | `beacon` (always true) |
| `video.view` | A user landed on `/videos/[id]` and the HLS player started loading | `videoId`, `userId`, `quality` ("480p" / "720p") |
| `video.context.attached` | The uploader attached one of her own unlinked (`generic`) videos to a cycle, meeting or quarterly slot from `/uploads`. `entity_type` `video_submission` | `contextType`, `contextId`, `quarter` (quarterly videos only, else null) |
| `video.context.unlinked` | A video captioned or uploaded for an observation cycle arrived after the cycle was signed off, so it was not added to the closed record and was made `generic` again: its uploader sees it as not linked on `/uploads` and can attach it elsewhere. Written by the link step on both paths (`packages/db/src/uploads.ts`, linkSubmissionToContext), with no actor. `entity_type` `video_submission` | `contextType` ("observation_cycle"), `contextId` (the cycle), `reason` ("observation_cycle.signed_off") |

## observation.* — cycle lifecycle (spec 059)

| Action | Fires when | Metadata captured |
|---|---|---|
| `observation.pre_form.submitted` | The pre-cycle form was submitted by the teacher being observed | `cycleId`, `actorId` |
| `observation.observer_form.submitted` | The observer (mentor / admin) submitted their observation notes | `cycleId`, `actorId` |
| `observation.post_form.submitted` | The post-cycle reflection form was submitted by the teacher | `cycleId`, `actorId` |
| `observation.signed_off` | The cycle was marked complete: its `observation_signoff` approval request was approved (Sign off on the cycle page, or `/approvals`), moving it post_submitted → complete. Written by the approval handler (`lib/observation/cycle-signoff.ts`); this row is the "signed by" record. `entity_type` `observation_cycle`, `user_id` the signer | `code`, `from`, `to`, `signedByUserId`, `signedAt` (ISO timestamp) |
| `observation.cycle.sent_back` | The cycle's sign-off request was answered with changes requested or rejected (Send back on the cycle page, or `/approvals`), moving it post_submitted → observed so the teacher can revise her post-observation form. `entity_type` `observation_cycle`, `user_id` the approver; the comment itself is on the approvals row, not here | `code`, `from`, `to`, `decision` ("changes_requested" / "rejected"), `commentLength` |
| `observation.scores.saved` | The observer (or a mentor / admin) saved the cycle's scored rubric: with the observer form, or revised afterwards while the cycle is observed or post_submitted. `entity_type` `observation_cycle`, `user_id` the scorer | `code`, `rubricId`, `criteria` (how many were scored), `total`, `max` |
| `observation.note.added` | A free-text note was attached to the cycle outside the formal forms | `cycleId`, `actorId`, `noteId`, `bodyLength` |

## mentor.* / pairing.* — mentorship lifecycle (spec 061)

| Action | Fires when | Metadata captured |
|---|---|---|
| `mentor.meeting.logged` | A mentor, or a `programme_admin` / `super_admin`, logged a meeting against a pairing they can access. `entity_type` `mentor_meeting`, `entity_id` the new meeting's id, `user_id` whoever logged it. The duration and notes are not recorded here | `pairingId`, `scheduledAt` (ISO timestamp) |
| `mentor.meeting.cancelled` | A mentor / admin cancelled an upcoming meeting (the other party is notified in the app while the "Meeting cancelled" notification kind is enabled, which is the default); entity is the meeting | `pairingId`, `scheduledAt` |
| `mentor.meeting.removed` | A mentor / admin removed a meeting whose time had passed (a mistaken entry; nobody is notified); entity is the meeting | `pairingId`, `scheduledAt` |
| `mentor.pairing.completed` | A pairing was marked complete (all required meetings logged) | `pairingId`, `actorId` |
| `mentor.commitment.toggled` | A commitment checkbox on a pairing was toggled on/off | `pairingId`, `actorId`, `commitmentId`, `now` (boolean) |

## teach_back.* — teach-back review (spec 097)

A teach-back is reviewed through the approvals queue (`lib/rtt/teach-back.ts`):
the upload's completion sends it for review (`approval.submitted`), and the
decision is an `approval.decided` row as well as the row below.

| Action | Fires when | Metadata captured |
|---|---|---|
| `teach_back.reviewed` | A reviewer approved a teach-back or requested changes to it from `/rtt/teach-back` (`POST /api/teach-back/[id]/review`): a mentor for her own mentees only, an observer, a `programme_admin` or a `super_admin`. Only a playable clip, and only one no decision has been taken on. `entity_type` `video_submission`, `entity_id` the video, `user_id` the reviewer. A clip with no review request (sent by WhatsApp, finished by the upload reconciler, or from before requests existed) has one created on its teacher's behalf and decided in the same step | `approvalId`, `decision` ("approved" / "changes_requested"), `created` (true when this review created the request) |

## rtt.* — RTT attendance (`/attendance`)

| Action | Fires when | Metadata captured |
|---|---|---|
| `rtt.attendance.marked` | A `programme_admin` or `super_admin` saved teachers' attendance at an RTT session on `/attendance/[rttSessionId]` and at least one mark changed (a save that changes nothing writes nothing). Only teachers on the session's roster can be marked; each changed row records `marked_by_user_id` and `marked_at`. `entity_type` `rtt_session`, `entity_id` the session, `user_id` who marked | `changed` (rows written), `counts` (how many were set to each status: present / late / absent / excused), `allPresent` (true when "Mark all present" was pressed) |

## system_settings.* — platform-wide tunables (spec 124)

| Action | Fires when | Metadata captured |
|---|---|---|
| `system_settings.update` | A `super_admin` saved a change on `/admin/system-settings` | `actorId`, `changedKeys`, `previous`, `next` (limited fields — full JSON in a separate journal table for diff replay) |
| `system_settings.surface_viewed` | `/admin/system-settings` rendered (SM-1 visibility) | `actorId` |

## helpdesk.* — internal helpdesk (spec 122)

| Action | Fires when | Metadata captured |
|---|---|---|
| `helpdesk.ticket_opened` | A signed-in user (any role) sent the Help panel's "Open helpdesk ticket" (`POST /api/helpdesk/tickets`). There is no ticket table: a `helpdesk.ticket` notification was inserted for every active `programme_admin` and `super_admin` other than the sender. `entity_type` `helpdesk`, `entity_id` the topic, or the page slug when there is none; `user_id` the sender | `topic` (null when none), `pageSlug`, `deliveredTo` (how many notifications were inserted) |
| `helpdesk.ticket_rate_limited` | A ticket was refused with 429 because its sender had already opened 5 this hour; no notification was sent. Written at most once per user per hour, by the first refusal: the throttle refuses every later POST in that hour without a row, so a loop cannot grow the log. `entity_type` `helpdesk`, `entity_id` and `user_id` the sender | `retryAfterMs` (what was left of the sender's hour) |

## notifications.* / user_prefs.* / dashboard.* / quickfind.* — UI-channel events

| Action | Fires when | Metadata captured |
|---|---|---|
| `notifications.mark_read` | A user marked one or more notifications read via `/api/notifications/mark-read` | `userId`, `notificationIds`, `count` |
| `user_prefs.update` | A user saved a UI preference through `PUT /api/user-prefs` (Settings, the language picker, the first-run tour and its replay). `entity_type` `user_prefs`, `entity_id` and `user_id` the user. Written for every save that sets at least one preference, even to the value it already had; a PUT that sets none is refused (400 `empty_patch`) and writes nothing | `keys` (the names of the preferences the save set; their values are not recorded) |
| `dashboard.viewed` | A user rendered `/dashboard` (loose "did the user come back?" signal) | `userId`, `role` |
| `quickfind.query` | The Cmd+K quick-find palette's search was answered (spec 121): `GET /api/quickfind` with 2 or more characters. `entity_type` `quickfind`, `user_id` the searcher. A refused search (too long, throttled, limiter unavailable) writes nothing. The text is kept as typed, as the learner search on `/repo/students` keeps its own: the row is the record of who looked up which teacher, school or session, and only a `programme_admin` or `super_admin` can read it (`/admin/audit`) | `q` (the trimmed search text, at most 240 characters), `resultCount` (rows shown, at most 20) |

## audit.* — meta-audit (read-on-write only)

| Action | Fires when | Metadata captured |
|---|---|---|
| `audit.bulk_export` | A `super_admin` downloaded the audit log itself via `/api/admin/audit/export` (spec 116). Writing this row IS the audit-of-the-audit | `actorId`, `rowCount`, `dateRange` (from/to) |
| `audit.bulk_export.gate_denied` | An admin-role session requested `/api/admin/audit/export` without an active `admin` section-gate grant; answered 403 `gate_required` and no row was read. Distinct from `audit.bulk_export` so the log never records an export that did not happen | `gateSlug` ("admin"), `reason` ("no_active_grant") |

## anti_download.* — SM-4 deterrence (spec 156)

These actions are emitted from the client-side `AntiDownloadGuard`
component via the audit-fanout endpoint, NOT directly through
`recordAudit` from server code. They flow back through
`/api/audit/resource-view` and land in the same `audit_log` table.

| Action | Fires when | Metadata captured |
|---|---|---|
| `anti_download.attempt.save` | The user pressed `Ctrl+S` / `Cmd+S` on a protected surface; the keydown handler intercepted and showed a toast | `key` ("ctrl-s" / "cmd-s"), `surfaceKey` |
| `anti_download.attempt.print` | The user pressed `Ctrl+P` / `Cmd+P` — print intercepted | `key`, `surfaceKey` |
| `anti_download.attempt.printscreen` | The user pressed `PrintScreen` (or the F12 dev-tools combo); not reliably blocked by browsers but the audit row captures the intent | `key`, `surfaceKey` |
| `anti_download.devtools.detected` | The dev-tools open/close heuristic fired (window outerHeight - innerHeight crossed a threshold) | `widthDelta`, `heightDelta`, `surfaceKey` |

## backup.* / restore.* — host jobs

Written by `scripts/backup.sh` (nightly) and `scripts/restore.sh` (the weekly
drill), not by the application: each appends one row to the live database per
run through `scripts/lib/audit-host-job.sh`. `user_id` and `entity_id` are
null (no account acts), `entity_type` is `host_job`. Best effort: a run that
cannot reach the database writes no row and says so in its own log, and never
fails because of it. `/admin/system-settings` shows the latest
`backup.complete` and `restore.complete`.

| Action | Fires when | Metadata captured |
|---|---|---|
| `backup.complete` | A backup finished: dump written and checked, mirror and off-site copy done or skipped, local retention applied | `dump` (file name), `bytes`, `storage_mirrored`, `shipped_offsite` |
| `backup.failed` | A backup exited non-zero | `error` (the failing check or line) |
| `restore.complete` | A restore drill passed and stamped `workspace/last_restore_drill.json` | `source` (dump file name), `backup_age_days`, `tables`, `users`, `storage_verified` (false: the drill covers the database only) |
| `restore.failed` | A restore drill failed and stamped the failure | `source`, `error` |

## demo_data.* — the day-one demo purge

Written by `packages/db/src/scripts/purge_demo_data.ts --apply` (README-deploy
3.1), in the same transaction as the deletes, so the row exists exactly when
they happened. `user_id` and `entity_id` are null (an operator runs the
script; no account acts), `entity_type` is `host_job`. A dry run, and an
`--apply` that finds nothing to remove, write nothing.

| Action | Fires when | Metadata captured |
|---|---|---|
| `demo_data.purged` | `--apply` removed the seed's fictional rows | `cycles` (`id`, `code` each), `pairings`, `teachers`, `mentors` (ids), `schools` (`id`, `code` each), `counts` (`cycles`, `pairings`, `teachers`, `mentors`, `schools`, `templates`, `unlinked_sessions`, `unowned_outlines`), `kept` (how many candidates of each kind it kept for real work) |

## approval.* — the approvals queue (`lib/approvals`, `/approvals`)

One queue for everything that needs a decision: a teacher's lesson plans,
sessions (with attendance) and marks, teach-backs, observation sign-off, and
account requests. `entity_type` is the item type (`session`, `lesson_plan`,
`assessment`, `teach_back`, `observation_signoff`, `account_request`) and
`entity_id` the item; `user_id` is who acted.

| Action | Fires when | Metadata captured |
|---|---|---|
| `approval.submitted` | An item was sent for approval and its pending request recorded | `approvalId` |
| `approval.decided` | An approver approved, requested changes or rejected a pending request | `approvalId`, `decision` ("approved" / "changes_requested" / "rejected") |

## account_request.* — "Request an account" (`/request-account`, `/approvals`, `lib/approvals/account-requests.ts`)

`entity_type` is `account_request` and `entity_id` the request. The deciding
rows are written alongside `approval.decided` (above), which records the
queue's side of the same decision. No address, phone number or password is
ever recorded here: the request row holds the person's details, and the
initial password exists only on the approver's screen.

| Action | Fires when | Metadata captured |
|---|---|---|
| `account_request.submitted` | The public form recorded a request and its pending approval. `user_id` is null on purpose: the person has no account, and whoever may be signed in on that browser did not make it. A second request from an address that already has one waiting, a filled-in honeypot and a throttled request write nothing | `approvalId`, `requestedRole` ("teacher" / "mentor" / "observer") |
| `account_request.approved` | A programme admin or super admin approved a request: the login (and, for a teacher, her teacher record at the requested school) was created and the approval recorded. `user_id` is the approver | `approvalId`, `role` (the role the login was given), `createdUserId` |
| `account_request.rejected` | A programme admin or super admin rejected a request; the reason is on the request and the approval | `approvalId` |

## grading.* — grade scales and observation rubrics (`/admin/grading`, `lib/grading/admin.ts`)

Written by `lib/grading/admin.ts`, which a programme admin or super admin
reaches from `/admin/grading` (and, for a quiz's scale, the admin quiz editor).
`user_id` is the administrator. `entity_type` is `grading_scale`,
`observation_rubric` or `quiz`, and `entity_id` that row. A refused change
(a name in use, a scale still named by an assessment, a rubric already scored)
writes nothing.

| Action | Fires when | Metadata captured |
|---|---|---|
| `grading.scale.saved` | A grade scale was created, renamed, had its bands replaced, or was switched on or off | `change` ("created" / "details" / "bands" / "activated" / "deactivated"), `appliesTo` ("student" / "quiz" / "observation"); with "bands" also `bands` (how many), `gaps` and `overlaps` (how many whole percentages 0-100 have no band / more than one); with "activated" / "deactivated" also `defaultCleared` (true when switching off the default left its kind with none) |
| `grading.scale.default_set` | A scale became the default for what it grades; the previous default stopped being one in the same transaction | `appliesTo`, `previousId` (the scale that was the default, or null) |
| `grading.scale.deleted` | A scale and its bands were deleted (only while nothing names it) | `name`, `appliesTo` |
| `grading.rubric.saved` | An observation rubric was created, renamed or given another scale, had its criteria saved, or was switched on or off | `change` ("created" / "details" / "criteria" / "activated" / "deactivated"); with "created" / "details" also `gradingScaleId` (null = the default observation scale); with "criteria" also `criteria` (how many now), `added`, `removed`; with "activated" / "deactivated" also `defaultCleared` |
| `grading.rubric.default_set` | A rubric became the one observers score new observations with | `previousId` (the previous default rubric, or null) |
| `grading.rubric.deleted` | A rubric and its criteria were deleted (refused while any observation has been scored against it) | `name`, `criteria` (how many were deleted with it) |
| `grading.quiz.scale_set` | The admin quiz editor chose the scale a quiz's results are graded with | `scaleId` (null = the default quiz scale) |

## teaching.marks.* — a teacher's assessments and marks (`/teaching/marks`, `lib/grading/marks.ts`)

Written by `lib/grading/marks.ts` for the teacher who owns the assessment
(`user_id`); `entity_type` is `assessment` and `entity_id` the assessment.
Sending it for approval is `approval.submitted`, above. A refused write (not
her class or assessment, a student not on its roster, a pending or approved
assessment) writes nothing.

| Action | Fires when | Metadata captured |
|---|---|---|
| `teaching.marks.assessment_saved` | A teacher created an assessment for one of her classes, or changed its details while it was still editable | `created` (true for a new one), `classId`, `subjectId`, `maxMarks` |
| `teaching.marks.saved` | A teacher saved her students' marks on an editable assessment | `marked` (students with marks), `absent` (students marked absent), `cleared` (rows removed because the student was left blank) |

## teaching.* — a teacher's own classes, students, lesson plans and sessions (`/teaching`, `lib/teaching/records.ts`)

Written by the server actions under `app/(authenticated)/teaching/{classes,students,plans,sessions}`
for the signed-in teacher (`user_id`), after they have checked the record is
hers and, for a plan or session, still editable. A refused write (not her
class, student, plan or session; a pending or approved record) writes nothing.
Sending a plan or session for approval is `approval.submitted`, above. Learner
names, ages and guardians are never written to metadata (SM-9): only ids and
which fields changed.

| Action | Fires when | Metadata captured |
|---|---|---|
| `teaching.class.linked` | A teacher added a class at her school to her list (`teacher_class` is the entity: her link); the school's grade row was reused or created | `classId`, `grade`, `section` (null = every section), `subjectId` (null = any subject), `classCreated` (true when the grade row was new) |
| `teaching.class.unlinked` | A teacher removed one of her class links (`teacher_class`); the class, its students and its sessions stay | `classId`, `section` |
| `teaching.student.created` | A teacher added a student to one of her classes (`learner`) | `classId`, `section` |
| `teaching.student.updated` | A teacher changed one of her students (`learner`); nothing is written when nothing changed | `classId`, `changed` (the field names: name, rollNumber, age, guardian, section) |
| `teaching.student.removed` | A teacher removed one of her students (`learner`): `deleted_at` is set, history stays | `classId` |
| `teaching.students.imported` | A teacher uploaded a students CSV on `/teaching/students` (entity `teacher`, her teachers row): one row per upload, written only when at least one student was added; the school and grade of each student came from her class, and no name is recorded | `rows` (data rows in the file), `created` (students added), `rejected` (rows not added: bad, or already on the list), `classIds` (the classes they were added to) |
| `teaching.students.viewed` | Learner names were rendered or downloaded for a signed-in user (SM-9): `/teaching/students` (entity `teacher`, her teachers row), a session's attendance list on `/teaching/sessions/[id]` (entity `session`), or its roster CSV, `GET /api/teaching/sessions/[id]/roster` (entity `session`) | `page` ("students" / "session" / "roster_csv"), `rowCount` |
| `teaching.plan.created` | A teacher created a lesson plan (`course_outline` owned by her), from scratch or by starting from a programme outline | `subjectId`, `grade`, `term`; when started from a programme outline also `copiedFrom` (the outline) and `lessonCount` (lessons copied) |
| `teaching.plan.updated` | A teacher changed an editable plan's details (`course_outline`) | `subjectId`, `grade`, `term` |
| `teaching.plan.deleted` | A teacher deleted an editable plan and its lessons (`course_outline`) | `lessonCount` |
| `teaching.lesson.saved` | A teacher added a lesson to an editable plan, or changed one (`outline_lesson`) | `outlineId`, `created` (true for a new lesson) |
| `teaching.lesson.deleted` | A teacher deleted a lesson of an editable plan (`outline_lesson`); the rest are renumbered | `outlineId` |
| `teaching.lesson.moved` | A teacher moved a lesson up or down (`outline_lesson`); a move past either end writes nothing | `outlineId`, `from`, `to` (sequence numbers) |
| `teaching.session.created` | A teacher planned a session for one of her classes (`session`, a draft) | `classId`, `subjectId`, `scheduledDate` |
| `teaching.session.updated` | A teacher changed an editable session (`session`) | `classId`, `subjectId`, `scheduledDate`, `status` |
| `teaching.attendance.saved` | A teacher saved an editable session's attendance (`session`) from the roster form: every student marked, or Mark all present; the session's counts were recomputed in the same transaction | `present`, `absent`, `late`, `excused` (students marked each way), `attended` (present + late), `total` |
| `teaching.attendance.imported` | A teacher uploaded an editable session's attendance as a CSV (`session`), written only when at least one student was marked; students the file does not name keep the mark they had, and the session's counts were recomputed in the same transaction | `rows` (data rows in the file), `marked` (students marked), `rejected` (rows not used), `present`, `absent`, `late`, `excused` (students the file marked each way), `attended` (present + late, over the whole session), `total` (students marked on the session) |

## Deferred prefixes (reserved but not yet wired)

These prefixes have docs / specs but no live `recordAudit` call sites
in the shipped codebase. Documenting them so the namespace stays
reserved. The wildcard form (`pairing.*`, `cycle.*`) is the
canonical reservation; the concrete sub-action names below are the
expected leaves once the surface ships.

- `pairing.*` — `pairing.created`, `pairing.advanced_to_quarter_2`,
  `pairing.ended`. Formal pairing lifecycle markers (currently the
  `mentor.*` family covers the active surface).
- `cycle.*` — `cycle.nominated`, `cycle.pre_submitted`,
  `cycle.complete`. Legacy aliases for `observation.*` events; kept
  reserved so downstream report queries can union the two namespaces.

## Substrate moats

- **SM-1**: `audit_log` is append-only. No `UPDATE` or `DELETE` allowed.
  Enforced at the DB layer (REVOKE + BEFORE triggers) and at the app
  layer (grep gate against `db.update(auditLog)` / `db.delete(auditLog)`).
- **SM-9** uses `learners.view`, `learners.bulk_view`, and
  `learners.bulk_export` to satisfy the learner PII audit moat. Bulk
  CSV export requires `super_admin`.
- **Rate-limit fail-CLOSED contract** (spec 141 + 163): any `*.rate_limit.redis_down`
  action signals a degraded state where the endpoint denied the
  request rather than letting it through. Pair the audit row with
  a 503 response to the caller.

## Adding a new action

1. Pick the prefix family (or open a new one — keep them few).
2. Append a row to the matching table above with the fires-when
   description and the metadata captured.
3. Call `recordAudit({ action: 'my_family.subaction', ... })` from
   the code path that wants to log.
4. Run `pnpm test -- tests/governance/test_171_docs_refresh*` to
   confirm the action you added is reflected in this file.
