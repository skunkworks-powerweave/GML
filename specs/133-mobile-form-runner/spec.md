# Spec 133 — Mobile form runner (Workflow Run 12 final frontend parity)

## Why

The JSX prototype at `LMS GML Frontend/mobile-runners.jsx::MobForm`
(lines 297-366) ships a touch-optimised, full-screen step-through
form runner that the live Next.js port still serves as the desktop
`FormRenderer` inside a narrow mobile shell. The result on a phone is
a vertically-stacked form with tiny inputs (8px padding, 13px text),
no progress indicator, and no review step — the same column of
controls the desktop view shows, just squeezed.

This is the final frontend-parity run. After this spec lands, every
prototype JSX surface (`forms.jsx`, `mobile-runners.jsx`,
`mobile-details.jsx`, `mobile-repo.jsx`, `mobile-login.jsx`,
`videos.jsx`, `repo.jsx`, …) has a production code path.

## What we ship

### 1. `apps/web/src/components/forms/MobileFormRunner.tsx` (CREATED)

New `"use client"` component. Same prop shape as `FormRenderer`
(spec 072) so the page-level server component can swap one for the
other based on the device cookie:

```ts
type MobileFormRunnerProps = {
  schema: FormSchema;
  initialResponses?: Record<string, unknown>;
  draftKey?: DraftKey;
  submitLabel?: string;
  action?: (formData: FormData) => Promise<void> | void;
  formId?: string;
  slug?: string;
  pairingId?: string | null;
  context?: Record<string, string>;
};
```

Layout — one field per screen:

- **Progress dots** at the top — one pill per field plus one for the
  review screen. Active step is a 28px-wide pill, past steps are
  small filled dots, future steps are small empty dots. Tap an
  earlier dot to jump back.
- **Field screen** — big serif "Question N of M" caption, big 16px
  label (with Hindi parallel label if `hindiLabel` is set), big
  input (44px+ tall, 16px text so iOS doesn't zoom on focus),
  optional help text (13px), inline error (var(--rust), 13px).
- **Likert** — vertical stack of 5 large radio rows (each 44px+ tall,
  matching the JSX prototype's emphasis on thumb-reach).
- **Rating** — large 56×56 tappable stars (well above the 44px floor).
- **Textarea** — multi-line input with `autoFocus`.
- **Review screen** — compact list of all answers with `Edit` link
  per question (jumps back to that field's step) + big Submit button.
- **Sticky footer** — Previous + Next, replaced by Previous + Submit
  on the review step. Footer respects `env(safe-area-inset-bottom)`
  for the iPhone home indicator; header respects
  `env(safe-area-inset-top)` for the notch.

### 2. `apps/web/src/components/forms/FormRenderer.tsx` (EDITED)

Export `normalizeOptions`, `isHindiNameField`, `validateField`, and
`validateAll` so `MobileFormRunner` can reuse them verbatim. Drift
between the two renderers' validation would mean a draft saved on
mobile could fail to submit on desktop and vice versa — the hard
rule from the workflow brief is "drop-in replacement", so the
helpers MUST be shared, not re-implemented.

### 3. `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx` (EDITED)

Conditionally render `MobileFormRunner` vs `FormRenderer` based on
`getDeviceType()` (spec 023 device cookie). Same `initialResponses`
(spec 130 prefill + spec 131-A prior-response layering), same
`draftKey`, same `submitFormAction`. No new logic — just one branch.

### 4. `tests/governance/test_133_mobile_form_runner.test.mjs`

Eight+ assertions covering: component existence + `"use client"`,
correct prop shape, prev/next/submit button presence, progress dots,
likert / rating / textarea touch-optimised renderers, safe-area
insets, page-level device branch.

## Acceptance criteria

- `MobileFormRunner.tsx` exists, declares `"use client"`, accepts the
  same prop shape as `FormRenderer`, exports a named
  `MobileFormRunner` function.
- The component imports `normalizeOptions`, `isHindiNameField`,
  `validateField`, `validateAll` from `./FormRenderer` (helpers must
  be shared, not re-implemented).
- The component reuses `saveDraft` from `@/lib/form-draft` with the
  same 1 s debounce as desktop.
- Renders progress dots, sticky Previous / Next, sticky Submit on the
  review screen.
- Touch targets minimum 44×44 px (asserted via `minHeight: TOUCH_TARGET`
  / `min-height: 44`).
- Safe-area insets honoured on top + bottom
  (`env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`).
- `forms/[slug]/page.tsx` imports `MobileFormRunner` and `getDeviceType`,
  branches on `device === "mobile"`.
- All five spec-kit files exist under `specs/133-mobile-form-runner/`.
- Governance test ships with 6+ assertions and passes green.

## Non-goals

- **No schema changes.** The runner is a pure UI swap — same
  `FormSchema`, same `DraftKey`, same server action.
- **No new env vars.** Device detection already uses the spec 023
  cookie + UA fallback.
- **No new dependencies.** All primitives are React + the existing
  `@/lib/form-draft` helpers.
- **No swipe gestures.** The Next / Previous buttons cover the
  navigation surface; swipe-to-advance would require either a new
  gesture library or a hand-rolled touch handler that fights the
  browser's native scroll. Punt to a future spec if field testing
  asks for it.
- **No mobile-specific server action.** The form posts the same
  FormData shape via the same `submitFormAction`. A response saved
  via the mobile runner is byte-identical to one saved via desktop.
- **No re-design of the review screen.** It mirrors the desktop
  Submit-section's spirit (single button, error inline) but in a
  vertical KV-list layout for thumb scrolling.
