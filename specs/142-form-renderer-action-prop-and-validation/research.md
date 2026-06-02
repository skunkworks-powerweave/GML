# Research 142

Five design choices documented in the spec, captured inline here so a
future contributor reviewing the same audit finding doesn't have to
reverse-engineer them.

## (1) Why the dead `action` prop was so quiet

When a `<form>` has no `action` attribute, the default behaviour on
submit is to POST to the current URL. The forms-runner page is a
server component at `/forms/[slug]` — a POST to it without a server
action handler responds with the page's own HTML (Next.js doesn't
route POSTs to page exports). The browser navigates to the same URL,
which on a re-render shows the same form, and the user-visible result
is "the page refreshed and my answers came back" — indistinguishable
to the user from an autosave-then-back nav. The forms-runner page
DOES have an autosave draft, so the answers DID come back. The
audit row never landed because no server code ran; the
`feedback_responses` row was never inserted. Critically, this is
SILENT — no thrown error, no console warning, no failing test
(because the seeded test doubles patched the `onSubmit` path).

The fix is a single line addition: `<form action={action}>` wires the
server action up correctly. React/Next then handles the POST + the
redirect to `/forms/[slug]/thanks` natively.

## (2) Why client-side `onSubmit` AND server-side `action` is a footgun

If a developer wires both, two things happen on Submit:

1. React fires the `onSubmit` callback. The caller's async function
   runs. If it mutates server state (the test doubles do), the side
   effect lands.
2. The browser then ALSO posts the FormData up to `action`. The
   server action runs, inserts the `feedback_responses` row, and
   redirects to `/forms/[slug]/thanks`.

End result: one click, two writes, one redirect. The audit row count
quietly inflates. We chose `console.error` in dev rather than
throwing because the existing forms-runner page already passes
`action` correctly — we don't want to break it on prod; we just want
to scream during local development if someone copies the pattern
wrong.

## (3) Why local `errs` + `disabled={submitting}` is the canonical race fix

The previous fix-attempt used only `setErrors(errs)` followed by
`if (Object.keys(errs).length > 0) return` — which IS already
correct because the local `errs` variable holds the post-validation
result. The race wasn't in validation itself; it was in the gap
between `setSubmitting(true)` (which queued a re-render) and the
button actually picking up the `disabled` attribute.

The double-submit window is:

```
[click 1] → onFormSubmit → validate → setSubmitting(true) → await flushSave()
                                                            ^
                                                            |
                                                            [click 2 lands here]
                                                            React hasn't re-rendered
                                                            yet; button still enabled
                                                            in the DOM.
                                                            click 2 fires another submit.
```

The fix can take one of two shapes:

- **Option A** (the spec uses this): keep `disabled={submitting}` on
  the button + early-return when `submitting` is already true. The
  early-return covers the in-handler race; the disabled attribute
  cuts off most clicks at the browser level once React has caught up.
- **Option B**: useRef-backed submitting flag that updates
  synchronously. More code, identical behaviour for our needs.

We picked Option A because it's smaller and uses primitives the rest
of the codebase already touches (no new ref pattern to learn).

## (4) Why we don't `preventDefault()` on the action path

For `<form action={action}>` to fire its native POST, the form
submission event must not be cancelled. So when `action` is set,
`onFormSubmit` only calls `preventDefault()` when validation fails
(to keep the user on the page so they can see the errors). When
validation passes, the event is allowed to bubble and the browser
POSTs the FormData to the server action.

This means the `submitting` state may briefly flash before the
browser navigates away — that's fine and matches the desktop
contract; the button label changes from "Submit" to "Submitting…"
for the 50-200 ms between click and navigation.

## (5) Why MobileFormRunner doesn't need the dead-action wire-up

MobileFormRunner has ALWAYS rendered a hidden `<form action={action}>`
at the bottom of its component tree, and its `onSubmitClick` calls
`formRef.current?.requestSubmit()` to fire it. So the `action` prop
was never dead on mobile — the submit path always worked. What we
fix on mobile is identical to desktop AFTER the action fix: the
discriminated-union assertion (in case a future caller wires both)
and the same early-return-on-submitting race guard.
