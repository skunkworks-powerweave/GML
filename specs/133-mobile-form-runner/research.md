# Research 133

Five design choices documented inline in the touched files.

(1) **One field per screen vs. grouped sections.** The JSX prototype
(`mobile-runners.jsx::MobForm`) groups by section index (mirroring
the seed JSON's section layout). For the production port we ship
one *field* per screen instead — the seed forms we're actually
running on (baseline / progress_1 / progress_2 / final feedback
forms in `packages/db/src/scripts/seed_forms_*.ts`) have at most
8-12 fields per audience, so one-field-per-screen yields 8-12 dots
worth of progress feedback, which is the right ergonomics for a
20-minute mentor reflection (the user sees they're making progress).
Grouped sections would mean two dots, two screens, a 6-question
form on each — same scroll problem the desktop runner has, just
inside a narrower viewport. The Next button validates only the
current field, so a user can't blow past a required field by
mistake.

(2) **Helpers exported from FormRenderer, not duplicated.** The hard
rule in the workflow brief is "drop-in replacement, same autosave
+ submit action contract". If `validateField` drifts between the
two renderers, a draft saved on mobile could fail to submit on
desktop and vice versa. So we export `normalizeOptions`,
`isHindiNameField`, `validateField`, `validateAll` from
FormRenderer and import them in MobileFormRunner. Visual atoms
(input styles, error styles) ARE duplicated — they're tuned for
the form factor — but the validation + option-normalisation
contract is single-sourced.

(3) **16px input font size to defeat iOS focus zoom.** Mobile Safari
zooms the viewport when a user taps into an input with `font-size
< 16px`. Desktop FormRenderer uses 13px (matches the chrome
density). For the mobile runner we lift everything to 16px input,
16px label so the page doesn't lurch on focus. The 16px floor is
documented in WebKit's source and confirmed by every mobile-design
guide (Stripe, Atlas, Tailwind UI). 13px on desktop is fine because
desktop browsers don't zoom on focus.

(4) **Safe-area-inset via env() with a max() floor.** iPhone notch +
home indicator are accounted for via
`padding-top: max(8px, env(safe-area-inset-top))` and
`padding-bottom: max(12px, env(safe-area-inset-bottom))`. The
`max()` wrap guarantees a minimum spacing on non-notch devices
(Android, iPad-mini, web preview) — without it, the buttons would
sit flush to the bottom edge on a phone with no inset, which looks
broken. The `env()` reads the actual inset on devices that report
one (iPhone X+, recent Pixel). No JS — pure CSS, so it works for
both server-rendered HTML and client-hydrated states.

(5) **Hidden form for server-action submit, not buttons inside a
`<form>`.** The desktop FormRenderer wraps everything in one
`<form onSubmit={...}>`. For mobile we render the *visible*
controls outside the form (so the Previous / Next button clicks
don't accidentally submit) and keep a hidden `<form
ref={formRef}>` with every value serialised as a `<input
type="hidden">`. The Submit handler calls
`formRef.current?.requestSubmit()` which lets the existing
`submitFormAction` server action read FormData with the same
`__formId` / `__slug` / `__pairingId` / `__ctx_<key>` /
field-name shape it expects from desktop. For multi-value
checkbox groups we emit one hidden input per value with the `[]`
suffix the server action already strips on the way in (spec 074
line 181 `if (key.endsWith("[]")) key = key.slice(0, -2)`). This
gives us a clean two-step UX on mobile (tap to advance, review,
submit) while keeping the wire contract byte-identical to desktop.

## Why a separate component rather than `if (mobile)` inside FormRenderer

FormRenderer is already 722 lines. Adding a 600-line mobile branch
inline would push it past the cognitive-load ceiling, and the two
renderers truly are different layouts (stacked vs. paged). The
shared concerns — validation, autosave, server-action contract —
ARE single-sourced via the four exported helpers + the
`saveDraft` import. The branch lives at the page level (server
component reads `getDeviceType()` once, picks a component) so
neither runner ships JS for the other.

## Touch-target compliance

The Apple HIG and Material Design guideline of 44×44 px applies to
every tappable element in the mobile runner:

- Likert buttons: `minHeight: 44`
- Radio rows: `minHeight: 44`
- Checkbox rows: `minHeight: 44`
- Rating stars: 56×56 (above the floor)
- Prev / Next / Submit buttons: `minHeight: 44`
- Edit links in the review screen: `minHeight: 44`, `minWidth: 44`

The `TOUCH_TARGET = 44` constant in the file makes the floor
auditable — a `grep -n "TOUCH_TARGET" MobileFormRunner.tsx` shows
where every tap target enforces the minimum.

## What we deliberately do NOT port from the JSX prototype

- **Section count progress bar at the top** (mobile-runners.jsx
  line 312). The seed forms in production don't carry meaningful
  section structure (most are single-section). Per-field dots are
  more informative for the user.
- **The "X / Y answered" mono counter.** Saved-state indicator
  (`Saving…` / `Saved`) is more honest about whether work is
  durable. The counter is a UI fiction when autosave is running.
- **The bottom "Submit" button labelled with a check icon.** We
  use plain text + the var(--ink) primary button styling to match
  the rest of the chrome.

These deviations are documented inline as comments in
MobileFormRunner.tsx so a future reader knows which prototype
choices were intentional drops.
