# Research 144

Five design choices that called for explicit consideration.

## (1) Partial UNIQUE INDEX, not full UNIQUE constraint

Postgres lets us write `CREATE UNIQUE INDEX … WHERE
whatsapp_message_id IS NOT NULL`. We pick that over a plain UNIQUE
constraint because most rows in `video_submissions` have NULL there:
direct tusd upload (spec 038) and external URL embed (spec 044) never
touch the WhatsApp ingest path. A full UNIQUE constraint would force
each of those NULL rows into a single-row index entry and Postgres
treats multiple NULLs as distinct by default — so it would work, but
the index would be twice as wide as it needs to be.

The partial predicate keeps the index small (it only stores actual
WhatsApp message IDs, of which there are at most ~50/day), keeps the
query plan obviously correct (planner can prove the index covers
only NOT-NULL rows), and surfaces the rationale at the schema level
in one line. The migration SQL is just two statements; there's no
intermediate trigger or stored procedure.

Source: `packages/db/src/schema/videos.ts` — the partial unique
index sits alongside the three existing btree indexes on
`video_submissions`. Drizzle's `uniqueIndex(...).where(sql\`…\`)`
emits exactly the PostgreSQL `WHERE` predicate.

## (2) Pre-check + ON CONFLICT, not just ON CONFLICT

The webhook performs a SELECT first AND wraps the insert in
`onConflictDoNothing`. Belt + suspenders intentionally:

- **Pre-check** lets us audit `whatsapp.message.replay_ignored`
  *before* doing the expensive Graph API media fetch +
  `downloadMediaBytes` + `putObject` round-trip. A retry hitting
  the pre-check exits in single-digit milliseconds and burns zero
  bytes of egress on the Graph API call. This is the dominant
  steady-state case (Meta's first retry usually arrives ~30s after
  the original, well after the original has finished).
- **ON CONFLICT** handles the narrow race window where two retries
  pass the pre-check concurrently — both selects see no row, both
  request the media URL, both arrive at the INSERT at the same
  time. Without the conflict clause, one transaction would error
  out with a unique-violation; with it, the loser path returns
  `[]` from `.returning()` and we cleanly audit + early-return.
  The downside is the loser still did the media download (a few
  hundred KB of waste), but that's a rare path and the alternative
  (lockless coordination, SELECT FOR UPDATE, or a separate dedup
  table) introduces more failure modes than it solves.

The two layers also separate concerns: the pre-check is the
application contract (audit + 200 → Meta stops retrying); the ON
CONFLICT is the data integrity guarantee.

## (3) Range header pass-through, not parsing

S3-compatible APIs (including MinIO) accept the verbatim HTTP Range
header in their GetObject SDK call. We don't parse `bytes=0-1023`
into start/end; we hand the string straight to `GetObjectCommand`
and let the storage backend tell us whether it was satisfiable.

This is a meaningful simplification:

- **No off-by-one risk.** Range syntax has surprising corners
  (suffix ranges `bytes=-1024`, open-ended `bytes=1024-`,
  multi-range with commas, large-file edge cases). Letting the
  storage layer interpret them means we inherit its (battle-tested)
  semantics for free.
- **No malformed-input branch.** S3 returns a 416 Range Not
  Satisfiable for a junk header; we surface it via the try/catch
  that already handles fetch failures.
- **Forward-compat with R2 / Tigris.** If we ever switch the
  storage backend (and SM-7 cost pressure suggests we might one
  day), the route handler doesn't need to change.

The only thing we synthesise is the response header echo — we copy
`r.ContentRange` and `r.ContentLength` from the SDK response back to
the client and tag `Accept-Ranges: bytes`. Browsers and HLS.js are
satisfied with that.

Source: AWS SDK v3 docs (`@aws-sdk/client-s3` GetObjectCommand
accepts `Range: string`); MinIO Range API parity is a documented
guarantee.

## (4) Why we don't return 200 + full body when Range fails

If the storage backend rejects the Range with a 416, the try/catch
falls through to our generic 502 path. We *don't* swallow the 416
and silently return the full body, because that would mask a real
client bug — HLS.js asking for byte ranges that don't exist (which
would only happen if the manifest and the segments got out of sync,
which itself is a real failure we want to see).

The 502 lands in the route's existing error envelope so ops sees it
in audit + the `error.tsx` boundary, instead of being silently
papered over.

## (5) Why we don't write a tracking table

A separate `whatsapp_messages` (msg_id, received_at, video_submission_id)
table was considered. Three reasons we didn't:

1. **Single source of truth.** The `video_submissions` row already
   *is* the receipt — adding another table just shifts the
   uniqueness question one join away without making it stronger.
2. **Schema footprint.** One column + one index on an existing
   table is a smaller diff than a new table + its own indexes + an
   FK relationship + a backfill plan.
3. **Audit coverage.** The `audit_log` table already records every
   `whatsapp.message.received` event with `metadata.msgId`. If ops
   ever needs to reconstruct the "did Meta send this twice"
   timeline, they query the audit log directly — no third surface
   needed.

If we *did* need to track non-video messages (text, location,
contacts) at some point, a separate table would make sense. For now
we only ingest videos, so the column-on-video_submissions approach
is the right scope.

## Why we re-export `Accept-Ranges: bytes` on the no-range path

A first-time visitor to a video page sends a no-range GET (HLS.js
fetches the manifest, then the player decides whether to use range
fetches based on `Accept-Ranges`). Without that header on the first
response, the browser doesn't know the resource supports byte
ranges, and the player falls back to full-segment refetches. Adding
the header costs nothing and unlocks the optimized seek path on the
very next round-trip.

## Why we don't gate the partial unique index on `source = 'whatsapp'`

A natural alternative: `WHERE source = 'whatsapp'`. We prefer
`WHERE whatsapp_message_id IS NOT NULL` because:

- It's tautological — only WhatsApp ingest sets that column, so the
  two predicates are equivalent today. But if a future source ever
  *does* want to participate in the same dedup mechanism (e.g.
  external_url ingestion gaining a "carry the source's idempotency
  key" field), it can opt in by simply setting the column, without
  the schema migration changing.
- It's more discoverable from the column type alone — a reader of
  the schema sees "this column has a partial unique index" without
  needing to follow the predicate back to a different column.
- Postgres can prove the index covers exactly the rows the
  application cares about with no additional inference work.

The cost is zero (NULL rows never enter the index regardless).
