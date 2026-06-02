# Tasks 133

- [x] T1 → write governance test (red) covering: MobileFormRunner
  file existence + `"use client"`, named export, props shape matches
  FormRenderer, helpers imported from FormRenderer (not duplicated),
  saveDraft import, progress dots + Previous + Next + Submit
  testids, touch-target floor of 44px, safe-area-inset env() usage,
  page-level branch on getDeviceType. Run suite → red.
- [x] T2 → edit `apps/web/src/components/forms/FormRenderer.tsx` to
  export `normalizeOptions`, `isHindiNameField`, `validateField`,
  `validateAll`. Keep all logic identical — only the visibility
  modifier changes. Verify the desktop renderer still builds (these
  helpers were already used internally).
- [x] T3 → create `apps/web/src/components/forms/MobileFormRunner.tsx`:
  `"use client"`, exports `MobileFormRunner({ schema,
  initialResponses, draftKey, submitLabel, action, formId, slug,
  pairingId, context })`. Renders one field per screen with progress
  dots, sticky Prev/Next, review screen + Submit. Hidden `<form
  action={action}>` for the server-action wire contract. Reuses
  saveDraft with 1 s debounce. All touch targets ≥ 44×44. Honours
  env(safe-area-inset-top / -bottom).
- [x] T4 → edit `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx`:
  import `getDeviceType` and `MobileFormRunner`, call
  `await getDeviceType()`, render `<MobileFormRunner ... />` when
  the result is `"mobile"`, else fall through to the existing
  `<FormRenderer ... />`. Pass the same props to either renderer
  (initialResponses, draftKey, action, formId, slug, pairingId,
  context) so a draft saved on one is consumable on the other.
- [x] T5 → author all five spec-kit files under
  `specs/133-mobile-form-runner/`.
- [x] T6 → run the scoped governance suite (`pnpm test -- --grep
  "spec 133"`) → green. Run the full suite to confirm no regression
  in the broader chrome (spec 130 prefill, spec 131 prior-response,
  spec 074 forms-runner, spec 072 form renderer all stay green).
- [ ] T7 (future) → port the rest of `mobile-runners.jsx`:
  `MobQuiz` (lines 369-467) → `MobileQuizRunner`. The current
  desktop quiz path renders fine in a mobile shell but a touch-first
  layout would close the parity gap. Out of scope here (this spec
  is forms-only).
- [ ] T8 (future) → add swipe-to-advance gesture as an enhancement
  on top of the Prev/Next buttons. Would require a gesture library
  or hand-rolled touch handler; punt until field testing asks.
- [ ] T9 (future) → carry the mobile renderer pattern to the
  observation cycle pairing (`/cycles/[id]/forms/[slug]`) once
  observation forms get their own slug-based catalogue. The
  prop contract is already isomorphic, so the swap is mechanical.
