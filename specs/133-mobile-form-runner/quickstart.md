# Quickstart 133 — Mobile form runner

Manual smoke (4 minutes):

1. Boot the stack: `pnpm dev` (web) + the docker-compose db / redis.
2. Sign in as a `mentor`. Use Chrome DevTools → Device toolbar to
   emulate iPhone 14 (390×844). The device cookie flips to
   `mobile` on the first paint via the useDeviceType client effect.
3. Navigate to `/inbox`. Click any feedback form card (e.g. the
   progress_1 mentor form attached to a pairing). The form opens
   at `/forms/progress_1-mentor-1?pairingId=...`.
4. Confirm the layout swap:
   - The page no longer shows a single stacked column. Instead you
     see one question screen at a time.
   - Progress dots at the top — one pill per field plus one for
     the review screen. The active dot is a wide 28px pill; past
     ones are filled dots.
   - Sticky Previous / Next at the bottom (Previous is dimmed on
     screen 0).
5. Tap Next without filling a required field — the inline error
   "This field is required." appears and the step does not advance.
6. Fill the field. Notice the input is 16px text (no zoom on focus).
   Tap Next — progresses to question 2.
7. After 2-3 questions, the "Saved" indicator briefly appears below
   the progress dots (debounced 1 s after the last keystroke). Force
   the page to reload — the form re-opens at question 1 with the
   first 2-3 answers prefilled from the draft.
8. Power through the rest of the questions. The last screen is a
   Review list — every answer rendered as a KV row with an Edit
   button. Tap Edit on any row — you jump back to that question's
   step (the progress dot you came from highlights again).
9. Tap Submit on the review screen. The mobile runner posts via the
   hidden `<form action={submitFormAction}>` — same server action
   as desktop. Redirects to `/forms/<slug>/thanks` on success.
10. Verify the response is in the DB:

   ```sql
   SELECT id, form_id, pairing_id, submitted_at
     FROM feedback_responses
    ORDER BY submitted_at DESC
    LIMIT 1;
   ```

   The row is identical in shape to any desktop submission — no
   mobile-specific column, no `__device` flag.

11. Flip the DevTools device emulation off. Reload `/forms/<slug>`.
    The desktop FormRenderer renders again. The draft is shared —
    if you switched to desktop before submitting, the same partial
    answers prefill the desktop runner. After submission either
    way, the draft row is gone (`clearDraft` called by both
    runners).

## Cross-device regression checks

- Sign in as a `teacher` on a real Android phone (or `?device=mobile`
  query — see `/admin/system-settings`). The mobile runner appears.
- The Hindi labels (e.g. `hindiLabel: "क्या आपने यह पाठ देखा?"`
  on the mentor forms) render in `var(--deva)` below the English
  label on each screen.
- Tap the rating field — five large stars. Tap star 4 — stars 1-4
  fill with the saffron colour, 5 is hollow. Tap star 2 — only
  stars 1-2 fill.
- Tap the likert field — five vertical rows, each 44px+ tall. The
  selected row inverts to dark ink with white text.
- Open the same form on iPad. The viewport is wide enough to be a
  desktop, so the cookie reports desktop and the FormRenderer
  surface shows.

## What to verify if anything breaks

- **Submit does nothing** — check the browser console. The hidden
  `<form action={submitFormAction}>` requires Next.js 15+; if you
  see "submitFormAction is not a function" the build is stale,
  rerun `pnpm build`.
- **Iso zoom on focus** — confirm every `<input>` and `<textarea>`
  uses `fontSize: 16` in the inline style (`grep -n "fontSize: 16"
  MobileFormRunner.tsx`). Anything under 16px will trigger Safari's
  zoom.
- **Buttons clipped on iPhone home indicator** — confirm the sticky
  footer uses `paddingBottom: "max(12px, env(safe-area-inset-bottom))"`.
  Without the env() the iPhone X+ models eat the bottom 34px.
