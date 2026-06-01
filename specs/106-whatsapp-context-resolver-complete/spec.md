# Spec 106 — WhatsApp Caption Context Resolver, Complete Coverage (Workflow Run 7 Tier C2)

## Why

The WhatsApp webhook parses the video caption to decide what
`video_submissions.context_type` and `context_id` to record. The original
implementation only resolved the `OBS-<code>` prefix (observation cycles,
looked up by `code`). The `TB-<id>` and `MM-<id>` prefix branches set
`context_type` correctly (`teach_back` / `mentor_meeting`) but left
`context_id = null`, so a downstream surface that wants to render
"videos for mentor-meeting X" or "videos for teach-back Y" had no link
to follow. From the operator's perspective, the videos arrived, the
admin grid showed them — but they sat orphaned because the parent entity
id was thrown away. The deployment audit (Workflow Run 7) flagged this
as a Tier C gap blocking the *first* mentor-meeting dogfood, where the
mentor needs to play the meeting's recording from the meeting's own page.

## What

Complete the context-resolution block in the webhook route to cover all
three known caption prefixes plus the catch-all generic branch:

- **`OBS-<code>`** → look up `observation_cycles` by `code` (existing
  behaviour, preserved). On miss, fall through to `generic` and audit
  `whatsapp.context.unmatched` with the raw caption + the reason
  `observation_cycle.code_not_found`.
- **`TB-<uuid>`** → validate the captured value is a canonical 8-4-4-4-12
  UUID (regex). If valid, use it as `context_id` directly — the
  `teach_backs` table is a soft-link namespace (no FK on
  `video_submissions.context_id`) and the teacher app generates the
  uuid client-side at teach-back submission time, so we trust the
  caption. If the captured value is not a valid uuid, fall through to
  `generic` and audit `whatsapp.context.unmatched` with reason
  `teach_back.invalid_uuid`.
- **`MM-<uuid>`** → validate uuid, then `SELECT id FROM mentor_meetings
  WHERE id = $1 LIMIT 1`. If found, set `context_id` to the row's id;
  if not found (mentor deleted the meeting between scheduling and the
  teacher's upload, or the teacher mistyped), fall through to `generic`
  with reason `mentor_meeting.id_not_found`. Invalid uuid → fall through
  with reason `mentor_meeting.invalid_uuid`.
- **anything else** → `context_type = 'generic'`, `context_id = null`,
  audit `whatsapp.context.unmatched` with reason `no_prefix_match`.

The fallthrough-to-generic semantic is deliberate: we never reject a
teacher upload because of a caption typo. The video lands in MinIO, the
row is inserted with `context_type='generic'`, and ops can see the raw
caption in `/admin/data/videos` and re-link manually.

## Why a UUID regex check before the DB lookup

Two reasons. First, hammering Postgres with `WHERE id = 'not-a-uuid'`
returns an immediate error (Postgres' uuid type rejects malformed input)
that propagates back to the webhook handler as an exception. We want a
clean fallthrough, not an exception. Second, the regex check is free
(O(36) characters) and the DB lookup is not (one round-trip per
caption), so on a malformed caption we save the round-trip.

## Audit shape

Every miss (`*_not_found`, `invalid_uuid`, `no_prefix_match`) writes one
`whatsapp.context.unmatched` audit row with metadata `{ msgId, caption,
reason }`. This lets an operator running
`SELECT reason, COUNT(*) FROM audit_log WHERE action =
'whatsapp.context.unmatched' GROUP BY reason` see at a glance whether
teachers are mostly making typos, mostly using wrong prefix tokens, or
mostly referring to deleted entities.

## Non-goals

- No FK from `video_submissions.context_id` to mentor_meetings. The
  table already uses a polymorphic context_id pattern (string id +
  context_type discriminator); adding a FK on one branch would break the
  pattern.
- No retry/repair workflow for orphans. Spec 098 (admin learners export)
  covers admin-side bulk re-linking via CSV; this spec only writes the
  audit trail that surface needs.
- No teach_back existence check. Soft link by design (see above).

## Definition of done

- All three caption prefix branches (OBS-, TB-, MM-) populate
  `context_id` on success.
- All four failure modes (OBS code not found, TB invalid uuid, MM
  invalid uuid, MM id not found) audit `whatsapp.context.unmatched`
  with a `reason` discriminator, set `context_type='generic'`, and
  insert the row anyway.
- Governance test `test_106_whatsapp_context_resolver_complete.test.mjs`
  passes.
