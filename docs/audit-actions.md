# Audit action taxonomy

`audit_log.action` is a `varchar(64) NOT NULL` column. Values follow a documented dotted-notation convention so reads of the audit log are scannable and groupable by prefix.

**Format**: `/^[a-z_]+(\.[a-z_]+)*$/` — lowercase letters and underscores, optional dotted segments.

## Recommended action prefixes

| Prefix | Examples | Source |
|---|---|---|
| `view` | `view` | generic entity read (e.g. cycle drill-in) |
| `edit` | `edit` | generic mutation through admin CRUD |
| `delete` | `delete` | generic delete through admin CRUD |
| `upload.*` | `upload.start`, `upload.complete`, `upload.failed` | direct-upload flow (spec 038+) |
| `transcode.*` | `transcode.queued`, `transcode.success`, `transcode.failed` | ffmpeg worker (spec 040) |
| `gate.*` | `gate.enter`, `gate.attempt.fail`, `gate.attempt.success`, `gate.rotated` | section gate flow (spec 009 + 021) |
| `login` / `logout` | `login`, `logout` | Auth.js session events |
| `whatsapp.*` | `whatsapp.message.received`, `whatsapp.media.fetched`, `whatsapp.media.failed` | WhatsApp webhook (spec 043) |
| `<entity>.view` | `learners.view`, `students.view` | SM-9 PII reads (spec 019) |
| `<entity>.bulk_export` | `learners.bulk_export` | SM-9 bulk-export ops |
| `pairing.*` | `pairing.created`, `pairing.advanced_to_quarter_2`, `pairing.ended` | mentorship lifecycle (spec 061) |
| `cycle.*` | `cycle.nominated`, `cycle.pre_submitted`, `cycle.complete` | observation lifecycle (spec 059) |

## Substrate moats

- **SM-1**: `audit_log` is append-only. No `UPDATE` or `DELETE` allowed. Enforced at DB layer (REVOKE + triggers) and at the app layer (grep gate against `db.update(auditLog)` / `db.delete(auditLog)`).
- **SM-9** uses `learners.view` and `learners.bulk_export` to satisfy the learner PII audit moat.

## Adding a new action

1. Pick the prefix family (or open a new one — keep them few).
2. Document it here.
3. Call `recordAudit({ action: 'my_family.subaction', ... })` from the code path that wants to log.
