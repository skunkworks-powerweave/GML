# Spec 131 — Form prior-response prefill + saved-indicator top-right

## Why

Two related FormRenderer gaps surfaced during the Workflow Run 11
frontend-parity sweep:

1. **No prior-response prefill.** When a user re-opens `/forms/[slug]`
   for a pairing where they already submitted the same template,
   `page.tsx` only reads `form_drafts`. If no draft exists (because
   they completed the form earlier and the draft was cleared on
   submit), the renderer starts blank — even though the canonical
   answers sit in `feedback_responses`. For re-takes, edits, and
   "review what I said last time" flows the user has to retype
   everything. The fix is a single keyed query against
   `feedback_responses` and a precedence rule (`draft > prior > {}`).

2. **The `Saved Ns ago` indicator is hidden in the bottom button
   row.** The JSX prototype at `LMS GML Frontend/forms.jsx:147`
   shows the saved-state pill in the **top-right of the form
   card** — it's a glance affordance that tells the user "your
   work is safe, you can navigate away." FormRenderer already
   tracks `lastSavedAt` and `saveState` (spec 072) and already
   renders a string; it just renders it in the wrong place and
   misses the trailing ellipsis on the "Save failed — retrying…"
   state called for in the spec brief.

Spec 131 closes both gaps with surgical edits — no schema
additions, no new dependencies, no public-API changes on
FormRenderer.

## What we ship

### A. Prior-response prefill — `/forms/[slug]/page.tsx`

After the existing `feedback_forms` lookup + `form_drafts` lookup,
add a third query against `feedback_responses` keyed by:

```ts
and(
  eq(feedbackResponses.formId, form.id),
  eq(feedbackResponses.respondentUserId, userId),
  eq(feedbackResponses.pairingId, pairingId),
)
```

ordered `submittedAt DESC` (most-recent retake wins), `.limit(1)`.

The query is gated behind `pairingId` — without a pairingId the
form can't be submitted at all (the page already redirects with
`?error=missing_pairing`), so the prior-response query would have
no key.

The composed `initialResponses` value handed to `<FormRenderer>`
follows this precedence:

```
initialResponses = draft.responses ?? priorResponses ?? {}
```

Draft wins because a draft means the user has typed something
since the last submit — those edits are newer than the persisted
response and must not be clobbered. If no draft, prior wins. If
neither, the form starts blank.

### B. Saved-N-seconds-ago indicator — `FormRenderer.tsx`

Move the existing `savedIndicator` JSX out of the bottom button
row and into a **top-right slot** within the form card. The
slot lives in a flex row at the top of the card; if the schema
has a `title`, the title sits on the left and the indicator
`marginLeft: auto`s to the right. If there's no title, the row
contains only the indicator. If autosave is disabled (no
`draftKey`), the row is not rendered at all — `null` short-
circuits the whole block.

Indicator copy:

| saveState | lastSavedAt | rendered text |
|-----------|-------------|---------------|
| any       | null        | `Not saved yet` |
| pending   | any         | `Saving…` |
| error     | any         | `Save failed — retrying…` *(color: `var(--rust)`)* |
| saved     | < 1 s ago   | `Saved just now` |
| saved     | ≥ 1 s ago   | `Saved Ns ago` *(N = seconds since lastSavedAt)* |

The live ticker is the same `forceTick` `setInterval(…, 1000)`
that already exists in FormRenderer for autosave bookkeeping —
no new timer is added. The `useEffect` that registers the
ticker already returns a cleanup function that calls
`clearInterval`, so unmount is clean.

The indicator carries `aria-live="polite"`, `data-saved-indicator`
(for governance + future RTL test hooks), and the
`var(--mono)` typeface from the prototype.

## Hard rules

- **No public-API change** on `FormRenderer`. The indicator is
  internal; callers don't get a new prop. (Spec 072's API
  contract — `schema / initialResponses / onSubmit / draftKey /
  submitLabel` — stays unchanged.)
- **No schema additions.** `feedback_responses` already has
  `formId`, `respondentUserId`, `pairingId` columns. The query
  hits indexes that already exist on the table (`pairing_id`
  has its own index per `feedback_responses_pairing_idx`).
- **No new timers.** The `setInterval` already there for the
  live ticker is reused.
- **Cleanup on unmount.** The existing `useEffect` that owns
  the ticker returns its `clearInterval` cleanup — verified.
- **Draft beats prior.** Precedence is `draft ?? prior ?? {}`.

## Acceptance criteria

- `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx`
  imports `desc` from `drizzle-orm`, queries `feedbackResponses`
  filtered by `formId + respondentUserId + pairingId`, ordered
  `desc(submittedAt)`, `.limit(1)`, and composes
  `initialResponses` as `draft ?? prior ?? {}`.
- The prior-response query is gated behind a truthy `pairingId`
  so missing-pairing requests don't pay the query cost.
- `apps/web/src/components/forms/FormRenderer.tsx` renders the
  saved indicator inside a top-of-card flex row with
  `marginLeft: "auto"`, carries `data-saved-indicator`,
  `aria-live="polite"`, and uses `var(--mono)` typeface +
  `var(--ink-3)` / `var(--rust)` colors.
- "Save failed — retrying…" string (with U+2026 ellipsis) is
  the literal copy for the error state.
- `savedIndicator` returns `null` when `autosaveEnabled` is
  false — the top-row block is not rendered for caller setups
  that don't pass a `draftKey`.
- All five spec-kit files exist under
  `specs/131-form-prior-response-and-saved-indicator/`.
- `tests/governance/test_131_form_prior_response_and_saved_indicator.test.mjs`
  passes with ≥ 6 assertions.

## Non-goals

- **No observation-cycle prefill.** `feedback_responses` has no
  `observation_cycle_id` column (only `pairing_id`). Observation
  cycles use a different render path (spec 075's runner). Out
  of scope.
- **No prior-response provenance UI.** When the prefill comes
  from `feedback_responses`, the form looks identical to a
  fresh draft. That's by design — the user is editing their
  own canonical answer, not reviewing a stranger's. The
  `submittedAt` timestamp of the prior row is not surfaced.
- **No FormRenderer API additions.** The hidden indicator
  remains internal. Callers that want a *different* indicator
  position can fork the component; we don't ship that knob.
- **No retro re-encoding of `responses` jsonb.** Older rows
  stay as-is. The renderer reads them straight.
