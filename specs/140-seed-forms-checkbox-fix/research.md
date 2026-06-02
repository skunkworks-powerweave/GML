# Research 140

Five design choices documented inline in the touched files.

## (1) Why a string rename, not a schema migration

The bug lives in user-space TypeScript — a typo in the local
`FieldKind` type alias at the top of `seed_forms_mentor.ts`. The
`feedback_forms.schema` column is a freeform `jsonb`, so Postgres
happily accepted the buggy plural at insert time and the renderer
silently fell through to the text fallback at render time.

Two paths were considered:

- **Path A — Rename in the seed only.** One-character fix, zero
  schema risk, idempotent against re-runs (the seed's natural-key
  guard means re-inserting the row with the corrected kind only
  succeeds on a fresh DB or after a manual sweep).
- **Path B — Add a Postgres CHECK constraint on the jsonb schema.**
  Forces every future writer to use canonical kinds. Rejected:
  - Adds a JSONB validation function and a migration.
  - Doesn't help the three sibling seeds which use bespoke
    audience-specific vocabularies that need a mapping table, not
    a flat allow-list.
  - The audit only flagged a single CRITICAL drift; a constraint
    would have to encode the full mapping vocabulary across four
    files, which is a larger surface to maintain.

Path A is what shipped. Path B is documented as a future option in
the tasks list.

## (2) Why the guard scans `field.kind` strings, not types

TypeScript's type alias only flags new code at the call site; it
does nothing for already-emitted data. A future contributor copy-
pasting a row from an older revision could re-introduce the same
plural and TypeScript would catch it, but only if the file was
re-compiled. The runtime guard runs every time the seed boots, so
it catches:

- Past seeds (already in DB rows) which now drop and warn.
- Future drift where a contributor adds a kind that the renderer
  doesn't dispatch on (e.g. a new `multi_select` proposal that
  hasn't been wired into FormRenderer yet).
- The case where the canonical set itself shrinks in a future
  refactor — every seed re-validates at boot, so dropping a kind
  from `CANONICAL_FIELD_KINDS` automatically pulls every
  now-unsupported field out of the seed.

The cost is negligible (a four-line linear scan of <100 fields per
seed; <1 ms total) so it runs unconditionally — no env flag
needed.

## (3) Per-file mapping tables vs a shared canonical vocabulary

Each of the three sibling seeds (mentee, observation, misc) uses
its own vocabulary that the dedicated renderer for that audience
expects. Examples:

- The mentee renderer (spec 073) reads `field.type === "likert_5"`
  and renders a 5-point Likert; rewriting the seed to emit
  `kind: "likert"` would break that renderer until it was patched
  in lockstep.
- The misc renderer (spec 080) reads `field.kind === "boolean-group"`
  to render a multi-row truthy/falsy checklist; collapsing it to
  `checkbox` would lose the semantic distinction.

So the guards keep each seed's local vocabulary intact, but
require every entry to be mappable to a canonical kind. The
mapping tables document the contract between the seed and the
renderer; if a future renderer change drops support for one of
the source kinds, the guard's mapping table is the single place
to update.

## (4) Warn-and-skip vs throw-and-halt

The guard logs a `console.warn` and drops the offending row from
the returned array. Throwing would have been louder but:

- Seeds are designed to be idempotent and self-recovering — a
  single bad row should not block the other three from inserting.
- A fresh deployment with a single bad row would otherwise
  require a manual edit of the seed file before the orchestrator
  could complete.
- The warn-and-skip pattern matches the existing seed style
  (`onConflictDoNothing`, per-row existence guards, per-row
  insert logging) — every other failure mode in these seeds is
  also handled with skip-and-continue.

A skipped row will surface in the operator's stdout when they run
`pnpm --filter @gml/db run seed:all`, so it's not silent — it's
visible-and-non-fatal.

## (5) Why the singular `checkbox` matches the renderer

`FormRenderer.tsx` (spec 072) lines 661-666:

```
) : field.kind === "checkbox" ? (
  <CheckboxGroup
    field={field}
    value={value}
    onChange={(v) => setField(field.name, v)}
  />
```

The dispatch ladder uses strict equality with the singular form.
The mobile equivalent (`MobileFormRunner.tsx` from spec 133)
mirrors the same branch at line 786. There is no plural alias
anywhere in either renderer; the singular is the canonical
contract. Renaming the seed to match the renderer is the correct
direction (not the other way round) because:

- The renderer's vocabulary is the source-of-truth — it's what
  every other consumer of the schema (preview, draft autosave,
  prior-response display) also reads.
- The other seeds (mentee, observation, misc) and every test
  fixture already use the singular convention. The plural in
  the mentor seed was a one-file outlier.

## Why no animation / behaviour change

The fix is purely a string-rename plus three defensive guards.
The renderer already does the right thing for canonical kinds; no
new branches, no new test fixtures, no new components shipped.
The only behavioural change a user will see is that the mentor's
`expertise_areas` field on the baseline form now renders as a
checkbox group (as the spec always promised) instead of a single-
line text input. That's the bug being closed.
