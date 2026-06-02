# Research 134 — mobile quiz runner

## JSX prototype reference

`LMS GML Frontend/mobile-runners.jsx::MobQuiz` (lines 369-467) is the
source. Key shape:

```js
const MobQuiz = ({ onBack }) => {
  const quiz = window.LMS.QUIZ;
  const [idx, setIdx] = React.useState(0);
  const [answers, setAnswers] = React.useState({});
  const [done, setDone] = React.useState(false);

  const q = quiz.questions[idx];
  const score = quiz.questions.reduce((n, x) =>
    n + (answers[x.id] === x.answer ? 1 : 0), 0);

  if (done) { /* result UI — we delegate to existing /result page */ }

  return (
    <>
      <MobBack onBack={onBack} title={`Question ${idx + 1} of ${...}`}/>
      <div /* progress bar div */ />
      <div className="m-scroll">
        <div className="m-screen">
          <div className="m-card">
            <h2>{q.q}</h2>
            <div /* options A/B/C/D */ />
          </div>
        </div>
      </div>
      <div /* sticky bottom action bar with Back + Next/Submit */ />
    </>
  );
};
```

The prototype scores client-side; the live implementation already
scores server-side (spec 120's `submitQuizAttempt` server action),
so we drop the client-scoring code-path entirely. The mobile
component only collects answers and posts via the same action.

## Device detection contract

`apps/web/src/lib/device.ts` exports `getDeviceType()` which reads
the `gml-device` cookie set by the `useDeviceType()` client effect on
first visit, with a User-Agent regex fallback. The same pattern is
used at `apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx`
(lines 70-74) which branches on `device === "mobile"` between
`<MobileEntityCardList>` and the desktop `<table>`.

Spec 134 mirrors that pattern exactly. We import:

```ts
import { getDeviceType } from "@/lib/device";
```

then `const device = await getDeviceType();` after the data load,
and branch on `device === "mobile"`.

## Touch target sizing

Apple HIG and Material Design both call for ≥ 44×44 pt touch targets.
We exceed that with:

- Option buttons: `min-height: 56` (matches the prototype's chunky
  feel and gives room for two-line option text on small phones).
- Action bar buttons: `min-height: 48` (smaller because they are
  text-only labels and pinned to the bottom edge — Apple's own
  bottom-bar buttons are 49pt by convention).

`touchAction: "manipulation"` on the option buttons suppresses
double-tap zoom, which would otherwise be triggered by quick
A→B re-selections.

## Safe-area handling

iPhone X+ notch and Android punch-hole devices report
`env(safe-area-inset-top)` / `env(safe-area-inset-bottom)` via CSS
env(). The existing `BottomTabs` and `MobileHelpFAB` components
already use this pattern. We apply the same to the runner's header
(top inset) and sticky action bar (bottom inset).

## Result page — no mobile variant

Read `/quizzes/[slug]/result/[submissionId]/page.tsx` — the result
card uses `maxWidth: 640` and a vertical question stack with
`gap: 12`. At 360px viewport this naturally collapses to full-width
with the same vertical reading flow. No new layout is needed.

If we ever did need a mobile-specific result, the cleanest hook is
to read `getDeviceType()` in the result page server component and
branch on a `MobileQuizResult` component — but spec 134 punts that.

## Why no new schema, env, or deps

- The grading contract lives in `submitQuizAttempt` at
  `quizzes/[slug]/page.tsx:30-92`. Mobile runner posts answers in the
  identical shape — `Array<{ questionId, selectedIndex }>` — so the
  insert into `quiz_submissions` and the `quiz.submit` audit emit
  the same payload for both layouts.
- `useState` and `useTransition` are stdlib React; no new
  npm install.
- Device cookie is set on the existing `gml-device` cookie name by
  `useDeviceType()` (spec 023 / 028) — no new cookie or env.
