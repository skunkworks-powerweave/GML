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

## auth.* — credentials + lockout + reset

| Action | Fires when | Metadata captured |
|---|---|---|
| `auth.rate_limit.redis_down` | The login-rate-limit channel throws (Redis outage); credentials endpoint fails-CLOSED (spec 141) | `method` ("credentials" / "reset"), `ipMasked`, `severity` ("SEVERE"), truncated `error` string |
| `auth.account.locked_attempt` | Login attempt against an account whose `users.locked_until` is in the future; bcrypt-verify is skipped (spec 161) | `userId`, `ipMasked`, `until` (ISO-8601) |
| `auth.account.locked` | The failed-credentials counter just crossed 5; a 1-hour lockout is being armed | `userId`, `ipMasked`, `until`, `failedCount` |
| `auth.account.unlocked` | A `super_admin` invoked `POST /api/admin/users/[id]/unlock` to clear a lockout before its natural expiry | `actorId` (the unlocking admin), `userId` (the cleared account) |
| `auth.password.reset_requested` | `/api/auth/forgot-password` accepted a form submission (response identical for known and unknown emails — no enumeration oracle) | `emailHashed`, `ipMasked`, `tokenIssued` (boolean — false if email unknown) |
| `auth.password.reset_failed` | `/api/auth/reset-password` rejected a token — expired, consumed-twice, or signature mismatch | `tokenPrefix` (first 8 chars), `reason` ("expired" / "consumed" / "not_found") |
| `auth.password.reset_completed` | The new password was successfully set and the token marked consumed | `userId`, `ipMasked` |

Auth.js session events (`login` / `logout`) are emitted by Auth.js
itself with the Auth.js-canonical action names; they are NOT under
the `auth.*` prefix above. Search the audit log for `action='login'`
or `action='logout'` to find them.

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
| `quiz.schema.update` | A `programme_admin` or `super_admin` saved the JSON editor on `/admin/quizzes/[id]`. `entity_type` `quizzes`, `entity_id` the quiz id, `user_id` the admin. A setting's key is present only when that save changed it | `questionCount`, `questionsReplaced` (boolean: the save carried a `questions` array); when changed, `title`, `passThreshold`, `timeLimitSeconds`, `maxAttempts`, `active` |
| `quiz.submit` | A learner's attempt was scored via `/quizzes/[slug]`. Graded server-side against the quiz's questions (spec 146); the `quiz_submissions` row is written in the same transaction that closes the learner's open `quiz_attempts` row. `entity_type` `quiz_submission`, `entity_id` the submission id, `user_id` the learner | `quizSlug`, `score` (percent), `passed` (boolean), `questionCount`, `answeredCount` |
| `quiz.attempt.expired` | A submission arrived after the quiz's time limit plus the 30 s grace; the attempt was closed and nothing was scored. `entity_type` `quiz` (singular), `entity_id` the quiz id, `user_id` the learner | `quizSlug`, `limitSeconds` |

## whatsapp.* — webhook ingest pipeline

| Action | Fires when | Metadata captured |
|---|---|---|
| `whatsapp.signature_failed` | Inbound webhook POST failed the HMAC-SHA256 signature check against `WHATSAPP_APP_SECRET` (spec 040). The endpoint returns 401 without doing any DB writes | `ipMasked`, `signatureProvided` (boolean) |
| `whatsapp.message.received` | A signed webhook payload was accepted; the wrapping audit row is written before any per-message processing so the count of distinct receives is recoverable even when downstream branches fail | `msgId`, `from` (E.164), `messageType` ("text" / "video" / "audio" / ...) |
| `whatsapp.message.replay_ignored` | The same `msgId` had already been processed within the de-duplication window | `msgId`, `originalReceivedAt` |
| `whatsapp.media.url_failed` | Meta's media-URL lookup returned non-200 (rare — usually a token expiry) | `msgId`, `httpStatus` |
| `whatsapp.media.fetch_failed` | The fetched media-URL download itself failed (network, S3 upload error) | `msgId`, `error` (truncated) |
| `whatsapp.media.fetched` | The media bytes were successfully fetched from Meta and uploaded to MinIO; a `video_submissions` row is about to be created | `msgId`, `mediaSize`, `mimeType`, `s3Key` |
| `whatsapp.context.unmatched` | A WhatsApp reply-context fell outside any recognised conversation slot (programme reply, cycle reply, mentor handoff, ...). Multiple call sites emit this with different `metadata.reason` values | `msgId`, `from`, `reason` ("no_context" / "stale_context" / "unknown_slot" / ...) |
| `whatsapp.log.surface_viewed` | The `/admin/whatsapp-log` page rendered (SM-1 visibility) | `actorId` |
| `whatsapp.transcode.resent` | An admin pressed "resend to worker" on the whatsapp-log page; a BullMQ job was re-enqueued for an already-ingested video that the worker had missed | `submissionId`, `actorId` |

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

## learners.* / mentors.* — SM-9 PII reads and bulk exports

| Action | Fires when | Metadata captured |
|---|---|---|
| `learners.view` | A single class's learners list was rendered on `/repo/class/[id]/learners` (SM-9 — every learner-PII read writes an audit row) | `actorId`, `classId`, `rowCount` |
| `learners.bulk_view` | The all-learners surface `/repo/students` rendered (multi-class scan) | `actorId`, `filterApplied`, `rowCount` |
| `learners.bulk_export` | A `super_admin` downloaded the learners CSV via `/api/admin/learners/export` (SM-9 bulk-export gate) | `actorId`, `rowCount`, `filterApplied` |
| `mentors.bulk_export` | A `super_admin` downloaded the mentors CSV via `/api/admin/data/mentors/export` (spec 160) | `actorId`, `rowCount`, `filterApplied` |

## resource.* / video.* — media playback

| Action | Fires when | Metadata captured |
|---|---|---|
| `resource.pdf.view` | A PDF resource was opened in the canvas-renderer surface `/repo/resource/[id]/view` (spec 087) — both the initial server-side render and subsequent client pings | `resourceId`, `userId`, `pageOpened` (initial render only) |
| `resource.view.client_ping` | A client-side ping from a PDF viewer kept-alive over the wire — same surface as above, sent ~every 60 s of active dwell | `resourceId`, `userId`, `dwellSec` |
| `video.view` | A user landed on `/videos/[id]` and the HLS player started loading | `videoId`, `userId`, `quality` ("480p" / "720p") |

## observation.* — cycle lifecycle (spec 059)

| Action | Fires when | Metadata captured |
|---|---|---|
| `observation.pre_form.submitted` | The pre-cycle form was submitted by the teacher being observed | `cycleId`, `actorId` |
| `observation.observer_form.submitted` | The observer (mentor / admin) submitted their observation notes | `cycleId`, `actorId` |
| `observation.post_form.submitted` | The post-cycle reflection form was submitted by the teacher | `cycleId`, `actorId` |
| `observation.signed_off` | The cycle was marked complete (all three forms submitted + sign-off) | `cycleId`, `actorId` |
| `observation.note.added` | A free-text note was attached to the cycle outside the formal forms | `cycleId`, `actorId`, `noteId`, `bodyLength` |

## mentor.* / pairing.* — mentorship lifecycle (spec 061)

| Action | Fires when | Metadata captured |
|---|---|---|
| `mentor.meeting.logged` | A mentor logged a meeting against an active pairing | `pairingId`, `actorId`, `meetingId`, `durationMin` |
| `mentor.pairing.completed` | A pairing was marked complete (all required meetings logged) | `pairingId`, `actorId` |
| `mentor.commitment.toggled` | A commitment checkbox on a pairing was toggled on/off | `pairingId`, `actorId`, `commitmentId`, `now` (boolean) |

## teach_back.* — teach-back review (spec 097)

| Action | Fires when | Metadata captured |
|---|---|---|
| `teach_back.reviewed` | A mentor / admin reviewed a teach-back submission and set its grade | `teachBackId`, `actorId`, `grade` |

## system_settings.* — platform-wide tunables (spec 124)

| Action | Fires when | Metadata captured |
|---|---|---|
| `system_settings.update` | A `super_admin` saved a change on `/admin/system-settings` | `actorId`, `changedKeys`, `previous`, `next` (limited fields — full JSON in a separate journal table for diff replay) |
| `system_settings.surface_viewed` | `/admin/system-settings` rendered (SM-1 visibility) | `actorId` |

## helpdesk.* — internal helpdesk (spec 122)

| Action | Fires when | Metadata captured |
|---|---|---|
| `helpdesk.ticket_opened` | A learner / teacher submitted the Help FAB form and a ticket row was inserted | `ticketId`, `userId`, `category` |
| `helpdesk.ticket_rate_limited` | The same user hit the 5-per-hour rate-limit on ticket creation — no row written | `userId`, `ipMasked` |

## notifications.* / user_prefs.* / dashboard.* / quickfind.* — UI-channel events

| Action | Fires when | Metadata captured |
|---|---|---|
| `notifications.mark_read` | A user marked one or more notifications read via `/api/notifications/mark-read` | `userId`, `notificationIds`, `count` |
| `user_prefs.update` | A user changed their UI preferences (language, theme, mobile-density) | `userId`, `changedKeys` |
| `dashboard.viewed` | A user rendered `/dashboard` (loose "did the user come back?" signal) | `userId`, `role` |
| `quickfind.query` | The CMD-K quick-find palette executed a search (spec 121) | `userId`, `query` (length only, NOT raw text — privacy), `resultCount` |

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

## Deferred prefixes (reserved but not yet wired)

These prefixes have docs / specs but no live `recordAudit` call sites
in the shipped codebase. Documenting them so the namespace stays
reserved. The wildcard form (`backup.*`, `restore.*`, etc.) is the
canonical reservation; the concrete sub-action names below are the
expected leaves once the surface ships.

- `backup.*` — `backup.complete`, `backup.failed`. Nightly backup
  script audit emission (deferred to spec 091 / 109).
- `restore.*` — `restore.complete`, `restore.failed`. Restore-drill
  audit emission (deferred to the same).
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
