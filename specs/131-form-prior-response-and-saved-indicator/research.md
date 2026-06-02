# Research 131

Four design choices documented inline in the implementation.

(1) **Prior-response key is `(formId, respondentUserId, pairingId)`,
not `(formId, respondentUserId, observationCycleId)`.** The brief
mentions `observation_cycle_id` as an alternative key, but the
`feedback_responses` schema (`packages/db/src/schema/mentorship.ts:89`)
has only `formId`, `pairingId`, and `respondentUserId` — no
`observation_cycle_id` column. Observation-cycle forms route
through a different table (`observation_response_items`, spec 075)
and a different runner. The honest single-table prefill we can
ship today is pairing-keyed; cycle-keyed prefill is a separate
spec that would need a schema migration we explicitly rule out
for Workflow Run 11.

(2) **Draft beats prior.** A `form_drafts` row exists when the
user has typed something since the last submit but hasn't pressed
Submit yet. Those edits are by definition newer than the
canonical `feedback_responses` row — overwriting them with the
prior response would erase in-progress work. Precedence is
`draft ?? prior ?? {}`, evaluated with nullish coalescing so
that an empty `{}` draft (legal — user cleared every field)
still beats a non-empty prior.

(3) **The prior-response query is gated behind `pairingId`.**
Without a pairingId the form can't be submitted (the page
already redirects with `?error=missing_pairing` from the server
action). Running the prefill query without a key would be a
table scan against `feedback_responses` ordered by
`submittedAt DESC` — cheap on a small table, but free is
cheaper. The `if (pairingId)` gate also keeps the type-narrowing
clean (`pairingId` is typed `string` inside the block, not
`string | ""`).

(4) **The "Saved Ns ago" ticker reuses the existing
`forceTick` interval.** FormRenderer already runs a
`setInterval(…, 1000)` for autosave bookkeeping (spec 072,
line 481). Re-deriving `seconds` from `lastSavedAt` inside the
`useMemo` that builds `savedIndicator` means we get a free
live update on every tick — no second timer, no extra
re-renders. The existing `useEffect` returns `clearInterval`
on unmount, so cleanup is already correct.

## Why the indicator moved from bottom to top

The JSX prototype (`LMS GML Frontend/forms.jsx:147`) renders
the saved-state pill in the bottom row next to the submit
button. But the spec brief calls for **top-right of the form
card** because:

- The bottom row is below the fold on long forms (baseline /
  endline / final feedback are 20+ questions). The user has
  to scroll to the bottom just to confirm autosave is working.
- The top-right slot is a glance affordance — same place
  Gmail / Notion / Google Docs put their "All changes saved"
  pill. The user can see at a glance that work is safe and
  navigate away without scrolling.
- Putting it next to the submit button conflates two
  semantics — "your draft is safe" vs "you're about to
  finalize." They're different actions; they should occupy
  different visual zones.

The bottom row keeps the submit button + (eventually) any
field-validation summary; the saved indicator no longer
fights for space there.

## Why no public-API change on FormRenderer

The renderer already takes a `draftKey` prop, and the
indicator's behavior is entirely a function of `draftKey`
existing + autosave running. Adding a `showSavedIndicator`
boolean would just be a re-wiring of `draftKey` semantics:
"if you pass draftKey, you want autosave, and if you want
autosave you want to see the indicator." Adding the prop
would create a way to ask for autosave-without-indicator,
which is a bad UX (silent saving is invisible saving) and
also a way to ask for indicator-without-autosave (the
indicator would be permanently stuck at "Not saved yet").
Neither is useful. Keep the API as-is.

## Error-state color

The spec calls for `var(--rust)` color on "Save failed —
retrying…". We use a ternary in the `style` prop:

```ts
color: saveState === "error" ? "var(--rust)" : "var(--ink-3)"
```

`--rust` is the LMS design system's "warning / failure"
hue (matches the required-field marker `*` and the form
error banner). `--ink-3` is the muted-foreground variant
for non-error states. The ellipsis (`…`, U+2026) matches
the JSX prototype.

## Trade-off: showing the prefill source to the user

We considered surfacing "Prefilled from your earlier
submission on Mon 28 Apr" above the form when the
prior-response branch fires. Decided against:

- The `submittedAt` timestamp is sometimes confusing
  (re-take vs original).
- A small chip risks looking like a status indicator
  ("waiting for review") which is what the audit log is
  for.
- If the user genuinely wants to know what they answered
  last time, the read-only review surface (future spec)
  is a better home.

Stay invisible. The form just looks pre-filled, the user
edits, the user submits.
