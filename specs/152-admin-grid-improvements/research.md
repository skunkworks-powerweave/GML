# Research 152

Five design choices, documented inline in the touched files and expanded here.

## (1) Why dispatch on Zod type names and not Drizzle column metadata

Two viable signals for "what type is this column":

- **Drizzle column metadata** (`col.dataType`, `col.columnType`). Available
  at runtime via `entity.table[key]`. The shape is "uuid", "text", "boolean",
  "integer", "PgEnumColumn"… It would let us skip the Zod indirection.
- **Zod schema of the same column.** `entity.formSchema._def.shape()` is
  the same map already used by `row-form.tsx::inferInputType` (spec 114).

We chose Zod because:

- **Single source of truth for the admin substrate.** The form already
  derives input types from Zod. Deriving filter types from the same map
  means the toolbar and the form can never drift — if a future entity
  declares a column as `z.string().email()` the input renders as text
  and the filter dispatches as ilike, consistently.
- **Type-narrow values land in the SQL.** Zod's `z.coerce.number()` and
  `z.boolean()` already declare the JS shape the column actually wants;
  the dispatcher just passes the coerced value through to `eq()`.
- **Enum options are a property of the Zod node, not the Drizzle node.**
  Drizzle's `PgEnumColumn` exposes the enum name but not the value list
  in a stable way. Zod's `ZodEnum` does (`enum.options`). That lets us
  validate `v ∈ options` before calling `eq()` and skip the call when
  the user types a value that doesn't exist — without dropping a 500
  in the user's lap.

The choice does mean a column that's declared in the Drizzle table but
NOT included in `formSchema` will fall through the dispatcher's "no
zodType" branch. That's acceptable — every column the admin can filter
on is also a column the admin can write to, so it's always in the form
schema. If a future entity declares a read-only column the dispatcher
would log a dev-mode warn and skip; that's the right failure mode.

## (2) Why a `null` return for "skip this filter" and not throw

The dispatcher could have thrown a typed error and the caller could have
caught it. We chose `null` because:

- **Skipping is a normal outcome, not an error.** If an admin types
  "asdf" into a number-only column input the right behaviour is to
  drop that filter and show the unfiltered grid — not 500 the page.
  Reserving exceptions for actual errors (DB connection lost, etc.)
  keeps the error monitor signal-to-noise high.
- **The skipped key still belongs in the audit row.** A `null` return
  lets the caller fold the rejected key into `skippedFilters`
  alongside the accepted ones, so the SM-9 audit metadata captures
  the user's intent regardless of whether the filter reached the DB.
  An exception would have lost the rejected key by the time the
  audit hook fires.
- **Dev-mode warn is enough to surface a real bug.** When a developer
  adds a new entity with a column shape the dispatcher doesn't yet
  handle (e.g. `z.date()`), they'll see the warn on the next page
  render. A real production deployment doesn't need to spam the
  console — the dispatcher silently skips, the user sees the
  unfiltered grid, the audit captures the attempt.

## (3) Why `.for("update")` and not `.for("update", { skipLocked: true })`

Drizzle's pg select chain supports both:

- **`.for("update")`** — blocks every other transaction until commit.
  The second writer waits, then re-reads the bumped version.
- **`.for("update", { skipLocked: true })`** — returns immediately
  with zero rows if the row is already locked. Useful for queue
  workers ("pick the next available job"), wrong for our shape
  ("PUT this specific id").

We want the blocking behaviour. A PUT to /api/admin/forms/<id> says
"update this form" — if another PUT is in flight the right answer is
"wait for it to finish, then apply mine on top", not "fail because
someone else is editing". The wait window is at most one transaction
round-trip (sub-second on a healthy pool); the alternative would be
a 409 Conflict that the UI has no clear way to surface yet.

If usage patterns change (a polling background job tries to bump every
form every minute, say) we'd revisit. Out of scope here.

## (4) Why fire `recordAudit` AFTER the transaction commits

Same shape as spec 148's gate-rotate transaction. Two reasons:

- **Audit logs commit intent, not commits.** If the audit row is
  written inside the transaction and the transaction rolls back, the
  audit row rolls back too — the admin reviewing /admin/audit never
  sees the attempted bump. If the audit row is written inside the
  transaction and the COMMIT succeeds but the audit write somehow
  fails, the transaction can't be unwound — the audit log is
  permanently inconsistent with the table. Either way the audit log
  drifts from reality.
- **Audit failure must not poison the rotation.** `recordAudit` is
  best-effort `void`-discarded (per SM-1 — see `lib/audit.ts`); a
  failure inside the transaction would propagate up and reject the
  whole PUT, undoing a perfectly good version bump because the
  log-write was unhappy. Firing AFTER the commit means the bump
  lands first; if the audit then fails we log to stderr and move
  on (the audit-log compaction job will reconcile via the actual
  table state at next run).

## (5) Why no integration test for the actual race

A real concurrency test would need two Node processes, two pg
connections, deterministic timing. Possible, but heavy for a governance
suite that runs in <30s. Instead the governance test pins the source
shape:

- the `db.transaction(async (tx) => ...)` wrapper is present,
- the SELECT inside the tx ends in `.for("update")`,
- `recordAudit` lexically appears AFTER the closing `})` of the
  transaction callback.

This is the "encode the contract in the test" pattern used throughout
the LMS test gate. The same pattern in spec 148's
`test_148_gate_rotate_transaction.test.mjs` is the reference shape.
Behaviour under real concurrent load is validated by the manual
quickstart on a 2-tab dev server.

## (6) Why both fixes live in one spec

Workflow Run 14 audit-closure consolidates ~16 MEDIUM findings into 7
agents. Issue 1 (filter dispatch) and Issue 2 (forms version race) both
touch the no-code admin substrate (specs 012-019 + spec 073) and are
both single-file edits. Splitting them into two spec folders would
double the spec-kit overhead with no narrative benefit. The two changes
are independent — the filter fix can land without the transaction fix
and vice versa — so the governance test verifies them as two
independent contracts, not a single coupled change.
