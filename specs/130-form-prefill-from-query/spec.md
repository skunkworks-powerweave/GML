# Spec 130 — Form prefill from query (`/forms/[slug]` context + prefill)

**Status:** in_progress · **Date:** 2026-06-02 · **Phase:** Workflow Run 11 (frontend-parity closure)

## Overview

The catalogue pages (075–078) link into `/forms/[slug]` with rich contextual
query strings — e.g. `/forms/observation-pre-1?cycleId=…&observerId=…` for an
observation pre-form, or `/forms/progress-mentor-1?pairingId=…&quarter=2` for a
mentor's Q2 progress review. Before this spec, only `pairingId` was honoured;
`cycleId`, `quarter`, `observerId`, and `kind` were silently dropped on the way
to the runner. Reports built downstream from `feedback_responses` therefore had
to re-discover the cycle / quarter / observer linkage by querying audit log
metadata that was never populated.

This spec closes that gap and adds a sibling capability — scalar field prefill
via `?prefill_<fieldName>=<value>` — so a catalogue link can seed sensible
defaults (`mentor_name`, `school_name`, etc.) without modifying the underlying
schema or the form template.

Both pieces are routed through hidden inputs the renderer plants in the form,
and the server action re-sanitizes every value before persisting (defence in
depth: a tampered DOM cannot inject a key outside a closed allow-list, and a
crafted URL with `?prefill_<unknown_field>=…` is dropped on the floor).

## Functional requirements

- **FR-001**: `/forms/[slug]/page.tsx` widens `searchParams` to
  `Record<string, string | string[] | undefined>` so it can read arbitrary
  context keys without per-key type churn.
- **FR-002**: A closed `CONTEXT_KEYS` set (`cycleId`, `quarter`, `observerId`,
  `kind`) is extracted from the query string. Each value is sanitized:
  `quarter` must parse to an integer in `[1,4]`; `kind` must match `[\w.-]+`;
  cycle/observer IDs must match `[a-zA-Z0-9_-]+` and be ≤ 64 chars.
- **FR-003**: The sanitized `context` dictionary is passed to `FormRenderer` as
  an optional `context?: Record<string, string>` prop. The renderer plants a
  hidden `<input type="hidden" name="__ctx_<key>" />` for each entry.
- **FR-004**: The renderer also plants `__formId`, `__slug`, `__pairingId`
  hidden inputs when those props are provided — restoring the spec 074
  intent for the server-action submit path.
- **FR-005**: `submitFormAction` re-reads each `__ctx_<key>` from FormData,
  re-sanitizes via the same `sanitizeContextValue` helper, and persists the
  surviving dictionary in two places:
  - As a `__context` key inside `feedback_responses.responses` jsonb (no
    schema change needed — the schema is locked per Workflow Run 11 rules).
  - As spread fields inside `recordAudit({ ... metadata })` so the audit
    log can be filtered by cycle / quarter / observer downstream.
- **FR-006**: The page reads `?prefill_<fieldName>=<value>` query params and
  validates `fieldName` against the active form schema's `fields[].name`
  set. Unknown field names are dropped on the floor (prevents HTML injection
  via field-name spoofing). Values longer than 256 chars are also dropped.
- **FR-007**: Prefill values are layered **under** any in-progress draft or
  prior submission — a draft / prior response always wins because it reflects
  work the user has already committed to. Prefill only fills empty slots.
- **FR-008**: The existing `?pairingId=` wiring from spec 074 is preserved
  byte-for-byte: same prop name, same hidden input, same redirect-on-missing.
- **FR-009**: `FormRenderer`'s public API only **extends** — the new prop is
  `context?: Record<string, string>` and is optional. All existing callers
  (spec 072, the catalogue runners) continue to work unchanged.

## URL examples

- `/forms/observation-pre-1?cycleId=8d…&observerId=44…` — pre-observation
  feedback bound to a specific observation cycle.
- `/forms/progress-mentor-1?pairingId=ab…&quarter=2` — Q2 progress review
  bound to a specific mentor pairing.
- `/forms/baseline-mentor-1?pairingId=ab…&prefill_mentor_name=Tsering` —
  seed the `mentor_name` text field with `Tsering`.

## Acceptance criteria

| AC | Verification |
|---|---|
| AC-1 | `CONTEXT_KEYS` declared as a closed const tuple including all four keys |
| AC-2 | `sanitizeContextValue` enforces quarter ∈ [1,4] and rejects free-form ID input |
| AC-3 | `submitFormAction` reads `__ctx_<key>` from FormData |
| AC-4 | Context is persisted into `responses.__context` and audit metadata |
| AC-5 | `prefill_<fieldName>` is honoured only for known schema field names |
| AC-6 | Drafts and prior responses outrank prefill values |
| AC-7 | `FormRenderer` accepts `context?: Record<string, string>` and renders hidden inputs |
| AC-8 | Existing `pairingId` hidden input is preserved |

## Schema gaps / deviations

- **No schema additions in this run** — `feedback_responses` keeps its current
  columns. Context is folded into `responses` jsonb under a reserved
  `__context` key (double-underscore prefix already excluded from field-name
  collection in the action loop).

## Out of scope

- Cross-validating cycleId / observerId against the database (would require
  joins the schema doesn't yet have FKs for). Future spec.
- Free-form context keys outside `CONTEXT_KEYS` — would re-open the
  HTML-injection surface this spec just closed.
- Prefilling non-scalar fields (likert, rating, checkbox arrays). Could be
  added but the brief only asks for scalar prefill.

## Audit hooks

- `form.submit` audit metadata now spreads the sanitized context keys (cycleId,
  quarter, observerId, kind) so the audit log can answer "what cycle did this
  feedback land against?" without reading responses jsonb.
