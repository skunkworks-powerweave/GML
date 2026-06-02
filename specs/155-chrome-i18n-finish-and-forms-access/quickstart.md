# Quickstart 155 — Topbar language picker + forms-runner audience gate

Two manual smoke checks, each ~3 minutes. The first targets the chrome
fix; the second exercises the audience gate.

## (A) Topbar language picker — pick / persist / reload

1. Boot the dev stack: `pnpm dev` + `docker compose up db redis minio`.
2. Sign in as any user (a teacher works fine — the picker is global
   chrome, not role-gated).
3. Look at the top-right cluster of the topbar. The chip next to the bell
   icon should read **EN** by default (the default locale when
   `user_prefs.uiLanguage` is unset).
4. Click the chip. The dropdown expands. Three rows render:
   - `English`
   - `हिन्दी` (rendered in Devanagari, `--deva` font)
   - `བོད་ཡིག` (rendered in Tibetan script)
   The currently-active row carries a dot marker and a faint background
   wash.
5. Click `हिन्दी`. The chip briefly flashes `…` (pending state). The
   document reloads. The chip now reads **हि** and every topbar /
   sidebar label that has a Hindi translation renders in Devanagari
   (Dashboard → डैशबोर्ड, etc).
6. Open `psql` (or any pg client) and confirm the row landed:
   ```sql
   select user_id, ui_language, updated_at from user_prefs
   where user_id = (select id from users where email = '<your-email>');
   ```
   `ui_language` should be `hi` and `updated_at` should be within the
   last few seconds.
7. Pick `English` again from the picker. The chip flashes `…`, the page
   reloads, chip reads **EN**, and the DB row flips back to `en`.

### Regression check (pre-fix shape)

8. Stash this branch and check out the parent commit (`git stash; git
   checkout HEAD~1`). The same picker now does NOT respond to clicks —
   the dropdown opens, you can SEE the three rows, but nothing happens
   on click. The chip stays on the literal string `EN` regardless of
   the `user_prefs.uiLanguage` value.

### Failure-path check

9. Pop the stash. Open DevTools → Network panel. Right-click on
   `/api/user-prefs` → "Block request URL". Click `हिन्दी` in the
   picker. The chip stays `…` briefly, then the dropdown closes and
   the chip reverts. A red inline error row "Network error — language
   not saved." appears inside the dropdown the next time you open it
   (until you pick again or close+reopen).

## (B) Forms runner — audience-vs-role gate

10. Seed both audiences of forms (already done in dev):
    `pnpm --filter @gml/db seed:forms`.
11. Sign in as a teacher user (role = `teacher`). Open the inbox; pick
    any mentee-audience form card (e.g. `baseline-mentee-1`). The runner
    loads, the autosave kicks in as you type. This is the legitimate
    path.
12. Now type a URL by hand into the address bar:
    `/forms/baseline-mentor-1?pairingId=<any-uuid>`. With the pre-spec
    code this would render the mentor baseline form against this
    teacher session. With the spec-155 fix:
    - The browser is redirected to `/forbidden` (the existing
      forbidden page renders).
    - Open `psql` and inspect `audit_log` for the denial row:
      ```sql
      select action, entity_type, metadata
        from audit_log
        where user_id = (select id from users where email = '<your-email>')
          and action = 'form.access.denied'
        order by created_at desc
        limit 1;
      ```
      The row should exist with:
      - `entity_type = 'feedback_form'`
      - `metadata->>'slug' = 'baseline-mentor-1'`
      - `metadata->>'requiredAudience' = 'mentor'`
      - `metadata->>'role' = 'teacher'`
13. Sign out, sign back in as a mentor user. Type the same URL
    (`/forms/baseline-mentor-1?pairingId=…`). The runner now loads
    normally — the gate lets mentors through.
14. Sign out, sign in as a programme_admin. Type
    `/forms/baseline-mentor-1?pairingId=…`. The gate currently blocks
    them too (the map is `mentor → ["mentor"]` ONLY). If the product
    team wants admins to preview forms for QA, that's a separate spec
    that widens `AUDIENCE_ALLOWED_ROLES`.

## Test gate

15. Run the scoped governance suite:
    ```
    pnpm test --filter @gml/web -- --test-name-pattern "spec 155"
    ```
    All eight+ assertions green. Full suite still passes (1197 / 1197
    pre-spec; this spec adds new tests but does not regress existing
    ones — the topbar test (027) reaches into Topbar.tsx but only
    pins the bell + queue + user pill, none of which we touched).
