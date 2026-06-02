# Quickstart 139 — Mobile swipe gestures

Manual smoke (4 minutes), all on a touch device (or Chrome
DevTools → Toggle device toolbar):

1. Boot the stack: `pnpm dev` (web) + the docker-compose db /
   redis / minio.
2. Sign in as a `mentor` on a viewport ≤ 768 px (the device
   cookie / matchMedia fork mounts the mobile shell).

## Detail-page swipe-back (MobileDetailFrame)

3. Navigate to any detail page that uses MobileDetailFrame — e.g.
   open the mentorship cycles listing, then tap a cycle to land
   on the cycle detail page. The page renders inside a 44 px
   header with a `←` back arrow at the top-left.
4. With your right thumb, swipe from somewhere in the middle of
   the page body rightward toward the right edge. As soon as the
   gesture travels ≥ 80 px horizontally (and stays within ± 40 px
   vertically), the page navigates back to the listing. Your
   scroll position on the listing is preserved.
5. Test the deep-link fallback: open `/mentorship/cycles/<id>` in
   a new tab (so `history.length === 1`). Swipe right. The page
   navigates to `/mentorship` (the `backHref` you passed) instead
   of `router.back()` (which would otherwise close the tab).
6. Repeat with the tap affordance — tap the `←` arrow at the
   top-left. Same destination, same scroll restoration. This is
   the "swipes are additive" contract: both paths lead to the
   same place.

## Form runner swipe-through (MobileFormRunner)

7. Open any mobile form — e.g. the feedback survey at
   `/forms/feedback`. The runner renders one question per
   screen with progress dots at the top.
8. Fill the first question. Swipe leftward (right thumb pushing
   left). The runner advances to the next question. The
   validation gate is the same as the Next button — if the
   field is required and empty, the swipe still triggers
   validation and the error message is shown; the screen does
   not advance.
9. Swipe rightward to go back. Previous works at every step
   except the first (the `goPrev` guard caps at step 0).
10. Land on the Review screen at the end. Swipe left. NOTHING
    happens — submit only fires from the explicit Submit
    button, never from a swipe. Swipe right works as usual.
11. Vertical scroll inside a long textarea field works
    natively — try a multi-line answer, scroll the textarea
    cursor up/down with a slow drag. The swipe detector
    rejects the gesture (vertical drift > 40 px) so the
    textarea behaves normally.

## Reduced-motion check

12. Toggle your OS reduced-motion setting on (Settings →
    Accessibility → Reduce Motion on iOS / Animation off on
    Android / Settings → Ease of Access → Display → Show
    animations OFF on Windows).
13. Repeat steps 4 and 8. The gesture still navigates — the
    contract is "gesture remains functional, animation
    feedback is dampened". The swipe-region containers expose
    `data-reduced-motion="true"` so any future CSS that adds
    slide-in / slide-out transitions can read it and short-
    circuit.

## Desktop regression

14. Resize the browser back to > 768 px (or hard-set the cookie
    `gml-device=desktop`). The desktop shell mounts. The
    MobileFormRunner is not rendered (the desktop forms page
    uses the regular FormRenderer); MobileDetailFrame is not
    rendered (the desktop page just emits the body directly).
    No swipe handlers are attached on desktop — verify via
    DevTools that no `pointerdown` listener exists on the
    `<main>` container.

## Test gate

15. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 139"
    ```
    All assertions green. Full suite still 982/982 (this spec
    adds new tests but does not regress existing ones — the
    additions are inside a hook and inside a wrapper component
    that no current test touches).
