# Research 126

Three design choices documented inline in the new page.

(1) **Sender phone comes from `audit_log.metadata->>'from'`, not from
`video_submissions`.** The schema has no `senderPhone` column on
`video_submissions` (and adding one would force a migration that
buys us very little). The webhook already records the phone in the
`whatsapp.message.received` audit row's `metadata.from` field
(api/webhooks/whatsapp/route.ts:96). We left-join on
`audit_log.entityId = video_submissions.id::text` and filter to
`action = 'whatsapp.message.received'` — Postgres' jsonb extract
gives us the phone in a single query. Falls back to "—" when the
audit row isn't present (rare; only happens if the audit insert
failed best-effort on the webhook hot path).

(2) **Resend transcode is a server action, not a REST endpoint.**
The /admin/gates surface uses REST API routes for rotation because
the share/rotate flow needs both POST + nested state. Resend
transcode is one-shot — submissionId in, BullMQ enqueue out, redirect
back. A server action keeps the round-trip co-located with the page
and dodges the auth-header / CSRF complications of a separate
fetch. (Same call shape as `signOffCycleAction` in spec 117.)

(3) **Parsing filter derives from `context_type`, not a separate
column.** The spec brief says "Filter by parsing result (matched /
unmatched)" — there's no `parsing_result` column on
`video_submissions`. But every successful caption parse sets a
non-`generic` `context_type`, and every fall-through sets
`context_type = 'generic'`. The webhook already records the
distinction (`whatsapp.context.unmatched` audit event). So matched
= `context_type IN
('observation_cycle','teach_back','mentor_meeting','classroom_session','mentee_quarterly')`,
unmatched = `context_type = 'generic'`. This avoids a schema
addition and stays consistent with what the audit log already says.

## Why not show the resend button on ready/reviewed rows

Re-encoding an already-`ready` HLS stream wastes worker cycles and
risks SM-3 ("a `ready` row must have a valid `hls_master_key` and
`verified_at`") if the new transcode fails midway and the old
columns get cleared. The safe set is `received` / `queued` /
`transcoding` / `failed` — stuck states the operator can actually
unstick. `review_pending` and `reviewed` are post-transcode and
shouldn't reach the BullMQ producer at all.

## Why /admin/whatsapp-log instead of /videos/whatsapp-log

The page is operator-grade (programme_admin + super_admin only).
Putting it under /admin/* matches the role-gate semantics of
/admin/audit, /admin/data, /admin/forms, /admin/gates. Teachers
clicking on the live videos library should never see this surface.
