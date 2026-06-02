# Research 169

## A. Why swipe on the mobile quiz (not the desktop quiz)

The desktop QuizRunner (spec 120) renders one card with all questions
scrollable, plus a single Next / Previous control. Swipe has no
natural mapping there — the whole card is one scroll surface and the
gesture would compete with the scrollbar.

The mobile runner (spec 134) is one-question-per-screen, with a
sticky bottom action bar. The full-width body is the natural target
for a horizontal flick the same way the form runner's body is. Spec
139 already established the `useSwipe` hook with thumb-friendly
thresholds (80px / 40px / 400ms) for the form runner; reusing it
here is "do what we already did, on the surface that newly needs it".

## B. Why the SignOutButton lives in `nav/` rather than `quickfind/`

The localStorage clear is *triggered* on sign-out but is conceptually
"chrome that runs before sign-out". The button lives next to the
form that calls signOut() (Topbar.tsx). It's the only consumer.

Putting it in `quickfind/` would imply QuickFind owns the sign-out
flow, which it doesn't — QuickFind only owns the recents storage
itself (the source of the leak). The wrapper button is part of the
nav-chrome surface that triggers cleanup; keeping it co-located with
the form it wraps mirrors how `LanguagePicker.tsx` lives next to
`Topbar.tsx` for the same reason.

## C. assertEnv() returning a structured summary, not a typed env object

A common pattern is to validate process.env into a typed `Env`
object that every consumer imports. We deliberately did NOT do that
because:

  1. The three vars are OPTIONAL configuration — the LMS boots fine
     with none of them set. A "must be valid or boot fails" envelope
     would force a typed object onto every code path.
  2. The downstream consumer (HelpPanel, UploadModal) wants to know
     not just "the value" but "was it present + valid" so it can
     decide whether to hide the affordance. An `EnvCheck` per field
     carries that signal cleanly.
  3. The "soft-fail" contract (production logs SEVERE but doesn't
     throw) lets the LMS keep running when an operator misconfigures
     the helpdesk phone. A typed-env pattern would have to break
     this with an environment-variable guard library; the
     hand-rolled approach keeps the contract explicit at the call
     site.

## D. Why empty strings, not missing keys, in bo.json

The spec-125 loadMessages used to test `targetGroup[key]` for
truthiness. With the new nested shape, an empty *namespace* on bo
would have the loop fall through harmlessly (target = {}) and the
fallback would win. But for *known untranslated keys*, we want a
visible signal during translation work.

Empty-string placeholders give us:

  - The bo.json file shape mirrors en.json's namespaces, which the
    spec-125 governance test asserts.
  - `loadMessages` treats `targetGroup[key] === ""` as missing (the
    new `value.length > 0` check) so the English value wins.
  - The dev-only `console.warn` fires on every empty bo key, telling
    the translator exactly which paths still need work.

If we'd left the keys absent entirely, an `Object.keys(target.login)`
audit would have missed them and the translator would have to grep
en.json to discover the gap.

## E. Why the regex is `^\+\d{8,15}$` (not E.164 strict)

E.164 in its full glory is up to 15 digits after a `+`, with national
prefixes and area codes. We don't care about national prefixes — the
wa.me API strips non-digits anyway. The 8-digit floor catches short
extensions / 4-digit office codes someone might paste in by mistake;
the 15-digit ceiling matches the E.164 maximum.

The `+` is mandatory because wa.me without a `+` interprets the
number as a regional format and a typo'd country code silently
becomes a different country's number. Pinning the `+` is the cheap
half of the safety check.

## F. Why we hide the WhatsApp button in HelpPanel but stub-disable the email button

A broken `wa.me/0123` deep-link opens WhatsApp into an error screen
the LMS has no control over. The teacher sees "Couldn't open chat"
with no useful context, then concludes the LMS is broken.

A broken mailto link does nothing visible — clicking it does
nothing or opens the mail client with garbage in the To field. Less
catastrophic. The disabled stub button is fine there because it
visibly communicates "this isn't configured" rather than launching
into a third-party error.

## G. Why MobileFormRunner's swipe pattern is a 1:1 fit (no new threshold tuning)

The form runner's gesture grammar is "one screen per question,
swipe to move between them". That's exactly the mobile quiz's
grammar. The thresholds (80px / 40px / 400ms) were tuned for
thumb-friendly use on cheap-Android-on-a-bumpy-bus inputs (the
Ladakh field reality). Re-using the same values keeps muscle memory
consistent between the two surfaces.

## H. Why we don't add a swipe-to-submit gesture

A swipe is a low-friction gesture. Submit is an irreversible
operation. Combining them is a footgun — a user mid-flick on the
last question gets their quiz auto-submitted, losing the chance to
review. Spec 159 already added a TIMER-driven auto-submit for
timed quizzes; that's the only path where submission happens
without an explicit click. The swipe-only-to-navigate contract
preserves the "explicit click to submit" floor.
