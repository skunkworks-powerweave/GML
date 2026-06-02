# Quickstart 169

## What you need to know

This spec adds four small UI / chrome polish items behind one
"Workflow Run 16 post-audit hardening" round. No DB delta, no new
deps, no breaking change for existing surfaces.

## How to verify locally

### A. MobileQuizRunner swipe

1. `pnpm dev`
2. Open a quiz on a narrow viewport (Chrome devtools → toggle device
   toolbar → iPhone SE).
3. Pick an option, then drag left across the question body. The
   runner advances to question 2.
4. Drag right. The runner reverses to question 1.
5. The Previous / Next buttons remain visible and clickable as
   before — swipe is additive.
6. On the last question, swiping left does NOT submit (submit is
   button-only).

### B. QuickFind clear on sign-out

1. `pnpm dev`
2. Sign in as teacher A. Open ⌘K / Ctrl+K. Click on any teacher /
   school / session row. Close the panel.
3. Re-open the panel: the recent shows up.
4. Click the user-pill in the top-right → click your name → sign
   out. (Or click the user-pill directly if the pill itself is the
   submit button on your build.)
5. Sign in as teacher B on the SAME device.
6. Open ⌘K / Ctrl+K. The recents list is empty — no teacher-A
   recent leaked across the handoff.

In devtools → Application → Local Storage, you should see zero
keys with the `gml.quickfind.recent.` prefix immediately after
sign-out.

### C. assertEnv() + UploadModal/HelpPanel WhatsApp gating

1. Set `GML_WHATSAPP_NUMBER=foo` in `.env.local`. Restart `pnpm dev`.
2. Navigate to `/videos` → click "Upload". The UploadModal opens
   WITHOUT the WhatsApp section — only the direct-browser-upload
   section is visible.
3. Open the HelpPanel (`?` key). The "WhatsApp programme team" row
   is HIDDEN — only the Email admin + Open helpdesk ticket rows
   appear.
4. `NODE_ENV=production pnpm build && pnpm start` — the boot log
   shows `[SEVERE][spec169] assertEnv() rejected 1 configured env
   value(s)` with the offending value.
5. Set `GML_WHATSAPP_NUMBER=+919876543210`. Restart. WhatsApp
   section returns in both the modal and the help panel.

### D. i18n keys

1. Open `apps/web/src/i18n/locales/en.json`. Confirm the `login` and
   `forbidden` namespaces exist with the keys listed in spec.md.
2. Confirm `hi.json` has Devanagari translations for the same keys.
3. Confirm `bo.json` has empty-string placeholders for the same
   keys.
4. `NODE_ENV=development pnpm dev`. Navigate to any authenticated
   route while the bo locale is selected in user_prefs.uiLanguage.
   The terminal shows `[i18n] missing bo:login.forgot.title —
   falling back to en` (and similar warns for the other empty
   bo keys).
5. The visible chrome shows the English string (because empty bo
   value triggers the fallback) — there is no `{key}` ICU
   placeholder leak.

## Roll-back

Each touchpoint is independent. If any one becomes a problem:

  - A. Remove the `useSwipe` import + the `ref={swipeRef}` /
        `touchAction: pan-y` attrs from the root container. The
        Previous / Next buttons still work.
  - B. Drop the `clearAllQuickFindRecents()` call from
        `SignOutButton.tsx`. The form-submit path is unchanged.
  - C. Replace `assertEnv().whatsappNumber.value` with
        `process.env.GML_WHATSAPP_NUMBER` in the videos/uploads
        pages and remove the `isUsableWhatsappPhone/Contact()`
        gates from UploadModal + HelpPanel.
  - D. Remove the `login` and `forbidden` namespaces from
        the three locale files and revert `loadMessages` to the
        spec-125 two-level shape.

No DB migration to roll back. No env vars to remove.

## Out of scope

- Translating the bo placeholders. A separate Ladakhi translator
  pass.
- Adding swipe to other mobile runners (MobileUploadRunner has no
  per-step navigation; MobileFormRunner already has swipe via spec
  139).
- A typed-env wrapper for the rest of the app. `assertEnv()` is
  scoped to the three GML_* vars these three surfaces consume.
- Making the QuickFind clear "delete cookie" style — the sign-out
  server action handles auth-cookie clearing; localStorage is the
  client-only state this spec addresses.
