# Research 153

Four design choices, documented inline in the touched files and
expanded here.

## (1) Why `active boolean` and not a `deletedAt` migration

The mentors schema (`packages/db/src/schema/mentorship.ts:33`) uses
`active boolean` to mark retired mentors:

```ts
active: boolean("active").notNull().default(true),
```

The audit prompt cautiously notes "verify the schema actually has
deletedAt — if not, use active=true". The schema does not. Two paths
were considered:

- **Migrate to a `deletedAt timestamptz` column.** Industry-standard
  soft-delete shape; mirrors the audit-trail pattern used for
  observation_evidence and observation_cycles. But the column would
  not change the surface behaviour — the index page, the admin
  registry, the seed, and the assignment workflow all already
  branch on `active`. Adding `deletedAt` would either duplicate the
  source of truth (now we have two ways to say "retired") or force
  a chained migration (rewire every read site to use the new
  column). Out of scope for a MEDIUM audit closure.
- **Use the existing `active` column.** One-line WHERE clause
  change at the detail page; mirrors the index page's predicate
  exactly. Symmetric with the rest of the codebase; zero schema
  delta; zero rewire risk.

The fix takes path 2. A future refactor moving the whole codebase to
`deletedAt` is a separate spec; today's win is closing the
inconsistency between the index and the detail in the minimum-touch
way.

## (2) Why the ISO regex + Date parse + round-trip equality (not Zod)

The session date filter receives strings from `URL.searchParams`. The
current regex `^\d{4}-\d{2}-\d{2}$` catches shape errors but not
calendar errors. Three layers of validation were considered:

- **Regex only (status quo, broken).** Catches "abc" but accepts
  "2026-13-45" → 500.
- **Regex + `new Date()` + `!isNaN()`.** `new Date("2026-13-45")`
  returns a *valid* Date (silently normalised to 2027-02-14). isNaN
  is false. Still broken.
- **Regex + `new Date()` + `!isNaN()` + ISO round-trip equality
  check.** After parsing, we slice `parsed.toISOString().slice(0, 10)`
  and require it to equal the input. "2026-13-45" parses to
  2027-02-14, the ISO slice is "2027-02-14", not equal to
  "2026-13-45", filter drops. "2026-02-30" parses to 2026-03-02,
  ISO slice is "2026-03-02", not equal, filter drops. "2026-06-15"
  parses cleanly, ISO slice is "2026-06-15", filter kept.

We chose layer 3. It catches every malformed calendar value without
introducing a Zod / date-fns dependency. The pattern is documented
inline so a future contributor reading the helper understands the
round-trip is the catch, not the regex.

The pattern of "round-trip a normalised representation" is the same
trick the auth layer uses to validate emails (parse + serialize + 
compare). Self-documenting once recognised.

## (3) Why a single-column index on teacher_id and not a partial

The audit asked for `CREATE INDEX mentor_pairings_teacher_idx ON
mentor_pairings(teacher_id);` — a simple btree. Two refinements were
considered:

- **Partial index on `WHERE ended_at IS NULL`.** Would shrink the
  index to "active pairings only", which is the most common
  query shape. But the teacher-detail page actually displays the
  FULL pairing history (active + ended), so we'd have to add a
  second non-partial index for the history lookup. Net result:
  two indexes, one query path that can use neither.
- **Compound index on `(teacher_id, started_at DESC)`.** Would
  let the planner skip the sort for the "latest pairing first"
  query. But the table is at ~120 rows; the sort is invisible
  even on the cold-cache page load. A compound index is twice
  the disk footprint and twice the write cost per UPDATE. Defer
  until EXPLAIN traces show a measurable cost.

The single-column btree is the minimum-surface fix that closes
the audit finding. A future spec with EXPLAIN evidence can promote
it to compound or partial if the production scale demands it.

## (4) Why no CREATE INDEX CONCURRENTLY

`drizzle-kit migrate` wraps each migration file in a single
transaction so a failure halfway through rolls everything back
atomically. `CREATE INDEX CONCURRENTLY` is incompatible with
transactional DDL in Postgres — it errors with `CREATE INDEX
CONCURRENTLY cannot run inside a transaction block`.

Two workarounds were considered:

- **Move to a `-- @no-transaction` directive.** drizzle-kit supports
  this in some versions; would require a journal-format change and
  a docs note about the partial-failure recovery.
- **Use a stand-alone runbook step.** Run the CREATE INDEX
  CONCURRENTLY outside the migration ledger; record it in the
  schema's `meta/` directory by hand.

Both add operational complexity for a 120-row table. The exclusive
lock during a non-concurrent CREATE INDEX completes in single-digit
milliseconds at this scale. We deliberately keep the migration
transactional and shaped like the rest of the ledger; the comment in
the SQL header documents the choice so a future contributor at
production-scale knows why the spec made the call.

## (5) Why the snapshot prevId chain matters

Drizzle stores a content-addressed chain: each snapshot's `prevId`
points to the previous snapshot's `id`. The migrate runner walks the
chain to determine which migrations have already been applied. If
0018's prevId pointed at 0016 instead of 0017, drizzle would
believe 0017 hadn't shipped and re-apply it — colliding with the
already-existing partial unique index from spec 144.

We verify the chain by:

1. Reading the literal `id` from `0017_snapshot.json`
   (`4c9d3e0a-8f7b-4026-c9e3-af2d6b5e4321`).
2. Writing it into `0018_snapshot.json.prevId`.
3. Picking a fresh UUID for `0018_snapshot.json.id` (must not collide
   with any prior snapshot's id).
4. Pinning the chain via a governance test that JSON-parses both
   snapshots and asserts `snap18.prevId === snap17.id`.

The chain assertion is the contract — without it a snapshot rebase
could silently break the ledger and only surface at deploy time.
