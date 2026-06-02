# Research 160

Four design choices, documented inline in the route file and expanded
here.

## (1) Why a dedicated route instead of the generic admin export

The generic `/api/admin/data/[entity]/export` route at
`apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts` emits
one row per `db.select().from(entity.table)` result, with the headers
taken from `entity.displayColumns`. For the mentors entity those are
declared in `apps/web/src/admin/entities/mentors.ts` lines 11-15:

```ts
displayColumns: [
  { key: "name", label: "Name" },
  { key: "bio", label: "Bio" },
  { key: "active", label: "Active" },
],
```

Three columns, none of them the audit-closure columns. The fix
options were:

- **Extend `displayColumns` on the mentors entity.** Bleeds into the
  generic admin grid UX — the no-code admin page would then show
  `id`, `hindiName`, `baseLocation`, `expertiseAreas`, and an inline
  count column. The first four are fine; the count column would
  require teaching the generic SELECT how to do a JOIN-with-GROUP-BY
  against a sibling table, which is well beyond what the generic
  shape supports.
- **Generalise the generic export to support join columns.** Even
  bigger blast radius. Every entity that wires up a join column would
  ripple through `apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts`.
  Pure infra spec — not what the audit closure asks for.
- **Ship a dedicated route for mentors that mirrors the learners
  export pattern.** Localised. The same shape (auth gate → role gate
  → SELECT → audit → text/csv response) the learners route already
  uses (`apps/web/src/app/api/admin/learners/export/route.ts`). Zero
  reach into the generic admin path.

We chose option 3. The dedicated route is ~80 lines and reads top to
bottom; the only code review delta vs the learners route is the role
allowlist (programme_admin + super_admin instead of super_admin
only) and the columns + join target.

## (2) Role gate — why programme_admin gets it but `mentor` doesn't

The learners export is `super_admin` only because learners are
children → PII → SM-9 contract. Mentors are NOT children; the bar to
clear is the standard SM-1 admin gate (bulk export of any admin
entity is an admin-only action).

Who's "admin" enough?

- `super_admin` — yes, by definition.
- `programme_admin` — yes, this is the role that runs the directory
  and would be the one exporting it for offline planning.
- `mentor` — no. A mentor logging in CAN view the index page (it's
  their peers' contact info), but bulk-exporting the directory is a
  different posture. Mentors → peer view; admins → operational
  artefacts.

The `apps/web/src/admin/entities/mentors.ts` registry entry already
encodes this split: `readRoles` includes `mentor`, `mutateRoles`
restricts to admins. The export gate aligns with `mutateRoles` (bulk
export is a side-channel mutation: it exfiltrates the table to the
filesystem of whoever is logged in).

## (3) `mentor_pairings.status = "active"` rather than NULL `endedAt`

Two viable predicates for "currently active pairing":

- `WHERE status = "active"` — uses the `pairingStatusEnum` column.
- `WHERE ended_at IS NULL` — uses the temporal end marker.

The schema (`packages/db/src/schema/mentorship.ts` line 47) declares
both, and the `/repo/mentors` index page itself uses the status
predicate (line 53). Aligning on `status = "active"` keeps the
export's pairing count visually consistent with the on-page count —
an operator who downloads the CSV and the page side-by-side sees the
same number in the mentee column and the `pairingsActive` CSV column.

A status row can be `paused` or `ended` while still having `endedAt
IS NULL` (state transitions don't always set the timestamp atomically
in our seed data). The status column is the source of truth; the
temporal column is the audit trail.

## (4) Audit shape — `mentors.bulk_export` after the SELECT

Two viable orderings:

- **Audit BEFORE the SELECT.** Lets the auditor see the intent even
  if the SELECT crashes. Downside: rowCount is null / unknown.
- **Audit AFTER the SELECT.** rowCount is accurate; if the SELECT
  crashed the export never happened so the missing audit row is
  semantically correct.

The learners export (`apps/web/src/app/api/admin/learners/export/route.ts`
lines 94-104) audits after the SELECT for exactly this reason ("the
auditor needs the exfiltrated row count to scope post-incident damage
assessment"). The mentors export follows the same pattern for
parity. The action key follows the dotted-notation convention
documented in `docs/audit-actions.md` and codified by spec 021's
varchar(64) action column — `entity.bulk_export`.

The `void recordAudit(...)` (no await) is intentional. A failure to
write the audit row must not block the user-facing 200 — the row was
already exfiltrated by the time `recordAudit` runs, and a degraded
audit channel is a separate concern owned by the `recordAudit`
internals (which already log failures via `console.error`). This
matches the learners export at line 96.

## (5) Why the in-page button is gated client-side AND server-side

The route handler is the source of truth on permission. So why also
hide the button in the page header?

- **No dead links.** A `mentor` role clicking a "Download CSV"
  button and landing on a 403 is a worse UX than not seeing the
  button at all.
- **Audit log noise.** Every 403 hit still goes through the route
  (auth → 403 JSON). Hiding the button means fewer no-op requests.
- **Consistency with the learners page.** The `/repo/students`
  page at lines 86-94 also hides its Export CSV button when the
  role can't call the route — same posture.

The `canExport` derivation is a single boolean inferred from
`session.user.role`. No new helper, no `Guarded` wrap, no client
component. Pure server-side ternary.
