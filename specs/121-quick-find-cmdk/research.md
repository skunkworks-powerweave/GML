# Research 121 — QuickFind ⌘K design notes

Three design questions had to be answered before the route + component
could land. The choices are documented in-source so a later spec
revisit doesn't have to relearn them.

## 1. Flat array vs grouped response

The JSX prototype's `WikiQuickFind` returned a flat result list and let
the renderer reconstruct groups visually. We mirror that here: the
`results` array contains rows of every kind interleaved, ordered by the
fan-out sequence (teachers → schools → classes → subjects → cycles →
pairings → outlines → sessions). The client renders a single
keyboard-navigable list with a `Recently viewed` / `Results · N` heading
band; users press `↓` once to reach any item, not `↓ → ↓` to traverse a
group boundary.

The alternative — `results: { teacher: [], school: [], … }` — was
considered and rejected: it makes the cap behavior ambiguous (`HARD_CAP=20`
across groups, or per group?) and forces the client to flatten before
arrow-key navigation works. The flat shape is the single source of truth.

## 2. Per-kind LIMIT vs single UNION-ALL query

We issue 8 small SELECTs rather than one UNION ALL. Reasons:

- Per-table indexes already exist (`teachers_school_idx`,
  `subjects_displayOrder`, etc.) and serve the ILIKE %term% pattern;
  the planner picks them per-statement.
- The `or(ilike(name, p), ilike(code, p))` shape differs per kind —
  forcing them into a single UNION would either over-select columns
  (NULLs for the kinds that don't have a `code`) or require a
  per-kind subquery anyway.
- The per-kind LIMIT 4 is honored at the database, not in JS; if we
  unioned them and limited 20 at the outer query, a kind with many
  matches (e.g. a school code that prefixes a lot of teacher names)
  would crowd out everything else.

The 8 SELECTs run in series. On the data volumes we expect (Run-10
seeds plus ~150 schools and ~2k teachers), this is well under 50ms
total even on cold connections.

## 3. Recents storage: localStorage vs server

The prototype stored recents in component-local state — they evaporated
on page navigation. We store them in `localStorage` keyed by user id
(`gml.quickfind.recent.<uid>`), capped at 5, deduped by `kind:id`.

We considered hitting a server endpoint to persist recents (e.g. a
`user_recent_quickfind` table), but the cost / benefit was poor:

- The signal is already audited (`quickfind.query` rows include `q`),
  so an operator doing post-hoc analysis has more than enough data.
- Server persistence requires another table + migration + retention
  policy, which we are not adding solely for a usability sugar.
- `localStorage` survives page reloads, which is the only durability
  the user perceives in practice. Cross-device sync is not a goal.

If a future spec wants cross-device recents, the same component reads
from a new server endpoint and falls back to `localStorage` — no
breaking change.

## Audit volume

Quickfind queries are noisy by design — every debounced keystroke is a
hit. SM-8's retention sweep already truncates audit rows by age, so
the floor on retention is whatever the global SM-8 setting holds; we
do not add a special-case shorter retention here because that would
require a schema column (per-action TTL) we don't yet have. If volume
becomes a problem, the next spec can either (a) batch debounced
queries into a single audit-on-modal-close row, or (b) add a per-action
retention override column to audit_log. Both are non-breaking changes
on top of what 121 ships.
