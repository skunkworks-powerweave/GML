# Quickstart 142 — FormRenderer `action` prop + validation race

Manual smoke (3 minutes), all on the dev stack:

1. Boot the stack: `pnpm dev` plus the docker-compose db/redis/minio.
2. Seed the forms tables if you haven't already (`pnpm --filter @gml/db seed`).
3. Sign in as a `mentor` who has at least one open feedback form in
   their inbox.

## Server-action submit path (the audit fix)

4. Open the inbox. Click a feedback form card — you land on
   `/forms/<slug>?pairingId=<id>`. The runner mounts FormRenderer
   (desktop) or MobileFormRunner (mobile).
5. Fill the required fields. Press Submit. The page should navigate
   to `/forms/<slug>/thanks` within a second. BEFORE this fix the
   page silently refreshed and your draft came back; AFTER the fix
   the `feedback_responses` row is inserted and you see the thanks
   page.
6. Open the network panel before clicking Submit. You should see a
   POST to `/forms/<slug>` (the page URL) with the FormData payload
   and a 303 redirect to `/forms/<slug>/thanks`.
7. Open the database. The `feedback_responses` table should have a
   new row keyed by `(form_id, pairing_id, respondent_user_id)`. The
   matching `form_drafts` row should be deleted (the server action
   does this in the same transaction).

## Client-callback submit path (preview surface)

8. Visit the admin form-builder (`/system-settings/forms` → edit a
   form → preview). The preview surface passes `onSubmit` instead
   of `action`. Press Submit on the preview. The callback fires,
   no FormData is POSTed, no audit row lands. The preview surface
   shows a success toast and resets.

## Both-prop dev-mode assertion

9. Open the project in your IDE. Temporarily edit the forms-runner
   page to also pass `onSubmit={() => {}}` alongside the existing
   `action={submitFormAction}`. `pnpm dev` reload. Open the form
   page; check the browser console — you should see
   `[FormRenderer] Both `action` and `onSubmit` were provided. …`
   (and on mobile, the matching `[MobileFormRunner]` warning).
   Revert the change.

## Rapid double-tap race fix

10. With Chrome DevTools open, throttle network to "Slow 3G" so the
    autosave PATCH and the server-action POST take a noticeable
    time. Fill the form. Click Submit, then *immediately* (within
    100 ms) click Submit again.
11. AFTER the fix: the second click is a no-op (the button picks up
    `disabled={submitting}` on the first click's re-render; even if
    a click slips through, the `if (submitting) return` early-exit
    in `onSubmitClick` covers it on mobile, and the discriminator
    on desktop means the validation gate + button-disabled together
    cover it). Network panel shows ONE POST.
12. BEFORE the fix: a small fraction of double-clicks (maybe 1 in 5
    on Slow 3G) produced TWO POSTs and TWO `feedback_responses`
    rows.

## Mobile parity

13. Resize the browser to ≤ 768 px (or set cookie `gml-device=mobile`).
    The MobileFormRunner mounts. Repeat steps 4–7. Same end state.
14. Repeat step 9 with the MobileFormRunner instead.

## Test gate

15. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 142"
    ```
    All assertions green. Full suite still ≥ 1083/1083 — this spec
    adds new assertions but the FormRenderer / MobileFormRunner
    edits are surgical, no existing test is broken.
