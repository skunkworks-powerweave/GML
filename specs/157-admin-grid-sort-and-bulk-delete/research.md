# Research — Spec 157

## Rationale

The audit at the close of Workflow Run 14 surfaced two pure feature
MISSES against the JSX prototype: sortable columns and bulk row
select+delete. Both are standard admin-grid affordances. The v1 grid
(spec 012) shipped without them; spec 114 added per-row edit/delete
plus column filtering; spec 152 hardened the filter dispatcher. Sort +
bulk-delete are the last two prototype features the no-code grid was
still missing.

## Alternatives considered

### Sort

1. **Client-side sort.** Pull all 50 rows for the current page and
   sort in JavaScript. **Rejected** — sort changes which rows are on
   the page (the 50 oldest by createdAt are different from the 50
   newest), so client-only sort fundamentally lies about the data.
   Must round-trip through SQL.

2. **Sort param as a single combined string `?sort=col:dir`.**
   **Rejected** — readability and tooling. URL inspectors and curl
   debugging are easier with two named params (`sort=name&dir=asc`).
   The JSX prototype used the two-param form so we match.

3. **No default sort — leave it as DB-defined order.** **Rejected** —
   Postgres without ORDER BY returns rows in storage order, which is
   undefined and can change with VACUUM. A user paginating without
   sort would see the same row twice or miss rows entirely. Default
   sort by `createdAt DESC` (newest first) matches the JSX prototype
   and matches what every admin user expects.

4. **Sort link as a button + JS handler vs `<Link>` to a new URL.**
   Picked `<Link>` because (a) it preserves the bookmark-the-URL
   property the filter UI already has; (b) it works without JS for
   server-rendered crawls; (c) the click-to-toggle pattern is just a
   URL state transition, no client state needed.

### Bulk select + delete

1. **Hidden `<form>` with multiple `<input name="rowIds">` per row.**
   **Rejected** — would require posting on every checkbox change OR
   using a hidden checkbox per row inside a form that only submits on
   the toolbar click. The latter works but mixes presentation
   (checkboxes scattered across rows) with intent (a single submit),
   which is exactly the case React Context was built for.

2. **React Context with `Set<string>` of selected ids.** **Picked.**
   Three components share state (per-row checkbox, header
   select-all, toolbar's count + Delete button). Context isolates the
   state to the client island without lifting state into the server
   component (which would force the whole grid to be a client
   component — a regression).

3. **Indeterminate checkbox via ref vs derived attribute.** Both
   work. We use a `ref={(el) => { if (el) el.indeterminate = someOn;
   }}` pattern because React 19's checkbox `indeterminate` prop is
   not part of the React DOM types (only via DOM ref). This matches
   the pattern in `apps/web/src/components/quickfind/QuickFind.tsx`.

4. **Native `window.confirm()` vs a styled modal.** **Picked
   `window.confirm()`.** Zero new components, zero new CSS, keyboard
   + screen-reader accessible by default, identical UX on mobile.
   Mirrors `DeleteRowButton` (spec 114). A future spec can upgrade UI
   without touching the server action.

5. **Single `DELETE … WHERE id IN (...)` vs N round-trips.**
   **Picked single delete.** Postgres handles 200-element IN clauses
   in a single round-trip; the txn is short; the audit row is one,
   not N. Postgres docs (libpq parameter limits) put the upper bound
   at 65535 placeholders, well above any realistic admin grid select
   size.

6. **`db.transaction` vs bare `db.delete`.** **Picked transaction**
   for atomicity. A failure midway through (e.g. a foreign-key
   restriction on row 47 of 50) rolls everything back. The user sees
   "deletion failed" and a stable grid state, not a partial delete.

7. **Audit `admin.row.bulk_delete` vs N `admin.row.delete` rows.**
   **Picked single `admin.row.bulk_delete` with count + ids[0..5]
   in metadata.** A 200-row bulk delete that audits 200 rows pollutes
   the log and makes "what did this admin do at 14:32" hard to read.
   The single row with `count: 200` is the right granularity.
   Sampling the first 5 ids in metadata gives investigators enough to
   spot-check; the full audit trail is the
   `revalidatePath` + the natural row-level delete trail through
   foreign keys (cascade audits happen at the schema level for tables
   that need them).

## Why metadata only carries the first 5 ids

Two reasons:

1. **JSONB column budget.** Audit log metadata is a JSONB column;
   storing 200 uuids = ~7200 bytes per row. A single power user doing
   100 bulk deletes a day = 720KB / day for one user. Five ids is
   180 bytes per row.

2. **Audit-log readability.** A reviewer reading
   `/admin/audit-log/admin.row.bulk_delete` wants to see the count
   and one or two sample ids — they don't squint at a 200-id JSON
   array. If they need the full list they have the deleted rows'
   foreign-key fanout (cascade) and the count to compare against.

## Why we don't role-gate at the client toolbar

The client toolbar is mounted on the grid the server already gated
for `entity.readRoles`. A learner cannot see the grid, so they cannot
see the toolbar. But a programme_admin with read access to an entity
they cannot mutate (rare but possible — `learners` is `piiAudited` and
might have asymmetric read vs mutate roles) WOULD see the toolbar
and click Delete. The server action's
`requireRole(mutateRolesFor(entity))` is the single source of truth:
the click 403s and nothing is deleted. The visual gate is a
nice-to-have we deferred to a future spec.

## What the JSX prototype carries that we did NOT port

- **Pinning a column** to the leftmost frozen position. Requires
  CSS sticky table-cell coordinates per column — a real engineering
  problem in pure CSS, deferred.
- **Resizable columns.** Pure UX polish, no value for v1.
- **Inline filter cell in each `<th>`.** Spec 114 already shipped the
  toolbar-style filter UI above the table — that's more discoverable
  than an inline-th filter for non-technical users.
