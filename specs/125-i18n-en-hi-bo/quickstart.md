# Quickstart 125 — i18n smoke test (3 minutes)

1. **Install** — `pnpm install` in the repo root. Verifies the
   `next-intl` ^4.13.0 dependency lands; check
   `apps/web/package.json` if you want to confirm.

2. **English baseline (no action needed).** Boot the app with
   `pnpm --filter @gml/web dev`, sign in, hit `/dashboard`. The
   sidebar reads "Dashboard / Classroom Observation / RTT Phases /
   …", the topbar's language pill shows "EN", and the right-column
   card heading reads "What's next" (teacher) or "Today" (any other
   role). This is the default-locale path.

3. **Switch to Hindi.** Visit `/settings`. Click the "हिन्दी" pill
   under the Language section; the save spinner blips to "Saved".
   Refresh `/dashboard`. The sidebar now reads "डैशबोर्ड / कक्षा
   अवलोकन / RTT चरण / …" in Devanagari script, and the right-column
   card heading reads "आगे क्या" (teacher) or "आज" (other roles). The
   greeting changes too: "सुप्रभात, X." in the morning.

4. **Switch to Bhoti.** Click the བོད་ཡིག pill on the same page.
   Refresh `/dashboard`. The sidebar now reads "མདུན་ངོས། / འཛིན་གྲྭའི་
   བལྟ་ཞིབ། / RTT དུས་རིམ། / …". The greeting becomes "ཞོགས་པ་བདེ།".

5. **Section gate.** Open `/gate/mentorship?next=/mentorship`. The
   lock-icon card title reads "Mentorship" / "मेंटरशिप" /
   "ལམ་སྟོན།" depending on locale. The "Unlock section" button label
   and the 8-hour lockout footer track the picked language too.
   Entering the wrong password still produces the spec-035 inline
   error.

6. **Pre-auth picker on /login.** Sign out, then visit `/login`. The
   3-button picker (EN / हिन्दी / لد) lives in the top-right. Click
   "हिन्दी"; the page refreshes and the "Sign in" button + "Welcome
   back." headline render in Hindi. Pick is persisted via a
   `gml-locale` cookie that the login layout reads on each render.
   After sign-in, the language source-of-truth shifts to
   `user_prefs.uiLanguage` and the cookie is ignored.

7. **Missing-key fallback.** As a translator-mode check: temporarily
   delete a key from `apps/web/src/i18n/locales/bo.json` (any leaf,
   say `nav.dashboard`). Run with `NODE_ENV=development`. Page
   renders the English fallback for that one key and emits a
   `[i18n] missing bo:nav.dashboard — falling back to en` warning in
   the dev server log. Restore the key when done.

## What to look for in the audit log

Spec 125 reuses the existing `user_prefs.update` action (spec 024)
when a user changes their picker selection; the audit row already
records `keys: ['uiLanguage']` so no new action type is needed.
