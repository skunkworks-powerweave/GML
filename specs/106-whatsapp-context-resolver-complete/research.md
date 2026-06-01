# Research 106

## D-001 — Validate UUID before querying Postgres uuid column

Postgres' uuid type rejects malformed input as a runtime error, not a
zero-row result. If we naively passed `ctx.code` to `WHERE id = $1`, a
mistyped caption would throw and our handler would 500. A
caption-format check via a `UUID_RE` regex turns malformed input into a
clean fallthrough (audit unmatched, contextType='generic', row still
inserts).

## D-002 — Soft link for teach_back, hard lookup for mentor_meeting

`teach_backs.id` is generated client-side by the teacher app (spec 066);
the caption *is* the canonical identifier and there is no FK on
`video_submissions.context_id`. So we accept the captioned uuid as
context_id without a DB roundtrip. `mentor_meetings.id` is generated
server-side and a mentor can delete a scheduled meeting; we lookup
existence to keep the polymorphic context_id at least minimally
consistent on insert.
