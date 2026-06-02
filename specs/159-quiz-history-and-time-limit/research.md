# Research 159

Five design choices, documented inline in the touched files and
expanded here.

## (1) Why NULLABLE time_limit_seconds (and not DEFAULT 0)

The original audit MISS asked for "a per-attempt time limit on quizzes
where appropriate". Three column shapes were considered:

- **`integer NOT NULL DEFAULT 0`.** Treats "0" as "untimed". The
  problem: the DB CHECK constraint would either have to allow `0` (in
  which case the range no longer guards against the editor shipping a
  10-second quiz that 0 = untimed gets confused with) OR we change
  the runner contract to "0 means infinite". Both are footguns.
- **`integer NOT NULL DEFAULT 3600` (= 1 hour).** Picks an arbitrary
  default. Existing rows would be retroactively timed, which silently
  breaks every formative quiz the field has been shipping for the
  past year. The audit MISS was "add the capability"; nobody asked
  for retroactive enforcement.
- **`integer NULL` (no default).** NULL = explicitly untimed.
  Non-NULL = a positive integer in [60, 7200]. The CHECK constraint
  is straightforward (`IS NULL OR BETWEEN 60 AND 7200`). Every legacy
  row picks up NULL with no surprise, and the editor opts in
  per-quiz from the JSON editor.

The fix takes path 3. NULL/untimed is the conservative default; the
editor flips it per-quiz when the assessment needs a cap. This also
keeps the TypeScript inferred type honest — `Quiz['timeLimitSeconds']`
is `number | null`, which the React props can pattern-match on instead
of treating "0" as a magic untimed value.

## (2) Why 60..7200 as the range bounds

The DB CHECK could in principle accept anything from 1 to 2^31 - 1.
We picked tight bounds for editor safety:

- **60s floor.** Anything shorter is a UX trap. The mobile runner
  renders one question per screen with a 56px tap target and a
  multi-line prompt; the learner can't realistically read + answer
  one MCQ in under a minute on a 2G handset. A "5-second quiz" is
  almost certainly a typo (the editor meant "5 minutes"); the
  CHECK + server-action validation refuses it and surfaces a clear
  error.
- **7200s (2h) ceiling.** The seed quizzes top out at 30 questions ×
  90 seconds per question ≈ 45 minutes. 2 hours is comfortable
  headroom for hypothetical long-form assessments without becoming
  an arbitrary "infinite" value. A "10-hour quiz" is more likely to
  be a bug than a real assessment — and if a future quiz really
  needs 10 hours, that's a separate ledger entry that updates the
  cap with a documented rationale.

Both bounds are documented in the schema's inline comment, the
migration's header comment, AND the editor's schema-reference aside,
so the contract is visible at every layer.

## (3) Why setInterval + ref-based auto-submit (and not a useReducer)

The countdown effect needs to:
1. Tick every second.
2. Read the latest selection map at 00:00 (the learner may have
   picked answers right before the deadline).
3. Read the latest question list (paranoid; in practice the prop is
   stable but the ref makes the contract explicit).
4. Fire exactly one server action even if a manual click happens at
   the boundary.
5. Tear down on unmount.

Three patterns were considered:

- **`useReducer` with timer state in the reducer.** Elegant but
  invites a re-render on every tick (the `remaining` value lives in
  state). At 1 Hz this is fine, but the auto-submit closure inside
  the reducer would still need a ref to read the live selection map
  (the reducer captures stale closures), so we'd end up with both a
  reducer AND refs.
- **`useEffect` + `setInterval` + state for `remaining` only.**
  State change re-renders the banner (cheap, the banner is a single
  div). Refs for the selection map / question list / submitted flag
  so the interval callback always reads the latest values. Cleanup
  is `clearInterval`. This is the minimum-surface pattern.
- **Server-side timer (page reloads every second).** Hard no — the
  user is in the middle of selecting answers; we can't blow up
  their input state once a second.

The fix takes pattern 2. Inline comments at every ref declaration
note WHY the ref is there ("interval tick needs latest map").

## (4) Why a `submittedRef` guard (the boundary race)

The auto-submit timer and the manual Submit click can both fire
simultaneously at the 00:00 boundary:

- Tick at T=0: interval callback computes answers and calls
  `submitAction(slug, answers)`.
- Click at T=0: button onClick computes answers and calls
  `submitAction(slug, answers)`.

Without a guard the user gets TWO `quiz_submissions` rows for the
same attempt. The server action audit records both as separate events;
the result page redirects to the LAST one to land (race-y);
fundamentally not what we want.

`submittedRef` is a synchronous `let`-like flag that both paths check
+ set before firing. The first path through wins; the second path is
a no-op. On error we reset the flag so a transient failure doesn't
permanently lock the runner out of submitting.

## (5) Why server-render the history page (and not client-fetch)

Three patterns for the history list were considered:

- **Server component with a SELECT.** Newest-first list, scoped to
  the current user, served with the page HTML. No JS needed on the
  client. The page is keyboard-navigable, screen-reader friendly,
  and prints cleanly. This is what we ship.
- **Client component with a `useEffect` fetch.** Adds a JS payload,
  a loading state, and a "spinner flash" on the cold render.
  Pointless for a static index — the rows don't change while the
  user is looking at them.
- **API endpoint + paginated infinite scroll.** Premature
  optimisation. The user will have ~5-20 attempts across all
  quizzes; one page renders the whole list comfortably. Pagination
  becomes worthwhile once a single quiz has >50 attempts, which is
  a separate spec.

The server-component shape also benefits the audit-trail story:
because the list is a SELECT off `quiz_submissions`, anything that
mutates the table (admin force-delete, schema migration) is visible
the next time the user loads the page. No client-side cache to
invalidate.

## (6) Why no `attempt_duration` column on quiz_submissions

The audit asked for "time taken (computed from createdAt →
submittedAt if tracked)". The schema does not currently track a
`started_at` event — `submitted_at` is the only timestamp on
`quiz_submissions`, and `quizzes.created_at` is the quiz's creation
date (not the attempt's start). To compute attempt duration we'd
need either:

- A new `started_at` column on `quiz_submissions` populated when the
  runner first renders.
- A wire-level start event that the client posts on mount (before
  any selection happens).

Both are real work and need careful handling of "user closes the
tab without ever submitting" — at which point there's no row in
`quiz_submissions` to update, so the data lives in some other
layer (a Redis TTL, a separate `quiz_attempts` table). All of that
is a separate spec. The audit MISS for spec 159 closes the missing
HISTORY surface; the missing ATTEMPT-DURATION surface waits for a
dedicated design.
