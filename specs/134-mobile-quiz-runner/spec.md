# Spec 134 — Mobile quiz runner (Workflow Run 12 frontend parity, FINAL)

## Why

The JSX prototype at `LMS GML Frontend/mobile-runners.jsx::MobQuiz`
(lines 369-467) defines a full-screen, one-question-per-screen quiz
layout specifically tuned for low-bandwidth Ladakh phones with notch
viewports. The live Next.js port at
`apps/web/src/components/quiz/QuizRunner.tsx` (created in spec 120)
serves the desktop layout — single card centered with a single
progress bar — and does not translate well to a 360px viewport.

Frontend-parity Tier I (mobile): the runner is the most touched
interactive screen for trainees, so it gets a device-specific layout.
This is the final Run 12 spec: after this run, the entire JSX
prototype is wired to a real backend.

## What we ship

### 1. `apps/web/src/components/quiz/MobileQuizRunner.tsx` (CREATED)

New `"use client"` component. Same prop surface as
`QuizRunner` (slug, title, questions, submitAction) so it is a
**drop-in replacement** on mobile-detected devices.

- One question per "screen" (no card wrapper, full-width layout).
- Top: progress dots (one bar per question, current one saffron,
  answered ones ink, untouched ones paper-3) + `1 / N` counter.
- Quiz title rendered with Crimson Pro 16px below the counter.
- Question prompt with Crimson Pro 22px, line-height 1.35.
- Four large A/B/C/D option buttons:
  - Background `var(--card-hi)` when un-selected
  - Background `var(--saffron)` when selected (tap fills with saffron)
  - Border `var(--line)` un-selected / `var(--saffron)` selected
  - `min-height: 56px` (≥ 44px Apple HIG / Material touch target)
  - `touchAction: manipulation` to suppress double-tap zoom
- Sticky bottom action bar (Previous on left, Next or Submit on right)
  with `min-height: 48px` buttons and
  `padding-bottom: calc(12px + env(safe-area-inset-bottom, 0))` for
  notch devices.
- Top header carries
  `padding-top: calc(12px + env(safe-area-inset-top, 0))` for the
  iPhone notch / Android punch-hole.
- Same grading contract as desktop QuizRunner — calls the same
  `submitAction` server action, which redirects to the same result
  page. **No new server action.**

### 2. `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx` (EDITED)

Add the `getDeviceType()` device check (already used at
`/admin/data/[entity]`) and conditionally render `<MobileQuizRunner>`
for mobile vs `<QuizRunner>` for desktop. Both share the same
`mappedQuestions` array and the same `submitQuizAttempt` action.

The desktop branch keeps the `← Dashboard` back-link header. The
mobile branch omits it because the mobile shell already supplies a
top app bar with back navigation.

## Acceptance criteria

- `MobileQuizRunner.tsx` exists, declares `"use client"`, exports
  `MobileQuizRunner`, and accepts the same `slug` / `title` /
  `questions` / `submitAction` props as the desktop `QuizRunner`.
- Component uses `useState` + `useTransition` (matches desktop
  pattern — server scoring, no client-side grading).
- Each option button has `min-height: 56px` (≥ 44 touch target).
- Each action bar button has `min-height: 48px`.
- Header uses `env(safe-area-inset-top, 0)` padding.
- Action bar uses `env(safe-area-inset-bottom, 0)` padding.
- Progress dots row carries `data-testid="mobile-quiz-dots"` so
  e2e can target it; each dot has a `mobile-quiz-dot-<i>` testid.
- Each option button has `data-testid="mobile-quiz-option-<i>"`.
- Submit button has `data-testid="mobile-quiz-submit"`.
- `quizzes/[slug]/page.tsx` imports both `QuizRunner` and
  `MobileQuizRunner`, calls `getDeviceType()`, and branches on the
  `device === "mobile"` condition.
- All five spec-kit files exist under
  `specs/134-mobile-quiz-runner/`.
- `tests/governance/test_134_mobile_quiz_runner.test.mjs` passes
  with at least 5 assertions covering the above.

## Non-goals

- **No mobile result page variant.** The existing
  `/quizzes/[slug]/result/[submissionId]` route already renders
  fine on small screens (max-width 640 card, vertical question
  stack). Adding a mobile-specific result would just duplicate code.
- **No new server action.** The mobile runner reuses
  `submitQuizAttempt` from the same page module so grading,
  audit emission, and redirect are identical.
- **No schema additions.** Pure UI.
- **No new dependencies.** Only React state primitives.
- **No score-page redesign.** Tier II (mobile-details.jsx /
  mobile-repo.jsx / mobile-login.jsx) is out of scope for this
  spec; it's a separate run.
- **No swipe gestures.** The Previous / Next buttons cover
  navigation. Swipe could be a future enhancement once mentors
  confirm the button flow on field tests.
