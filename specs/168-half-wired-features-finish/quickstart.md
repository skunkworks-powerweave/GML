# Quickstart 168 — Half-wired features finish

Four manual smoke checks across the four shipped features. Total
time under ten minutes.

## (A) system_settings consumers

1. Boot the stack:
   ```
   docker compose up -d db redis minio
   pnpm --filter @gml/web dev
   ```
2. Sign in as super_admin and visit `/admin/system-settings`. Confirm
   the form loads with the singleton row's current values.
3. Change `programmeName` from "Goldenmile RTT" to "Goldenmile RTT
   (test)" and save. Confirm the audit row "system_settings.update"
   lands in `/admin/audit`.
4. Navigate to `/admin`. The page header should read:
   ```
   Admin · 2026-27
   Goldenmile RTT (test)
   ```
   (Not the hardcoded "Goldenmile RTT" pre-spec-168.)
5. Revisit `/admin/system-settings`. Disable every notification
   category (uncheck all 7 boxes) and save.
6. As a different user with at least one unread notification, sign
   in. The Topbar bell badge should now render as `null` (hidden) —
   the unread count is filtered to 0 by the enabledKinds=[] branch.
7. Re-enable `cycle.assigned`. The bell badge appears again if any
   cycle.assigned notification is unread.
8. Visit `/videos` as a teacher. Click "Upload". In the
   browser-upload section, the explainer text reads:
   ```
   Resumable upload, MP4 / MOV / 3GP, transcodes to 480p HLS after
   the upload finishes (set by the programme admin in system
   settings — spec 168). …
   ```

## (B) /login/forgot SMTP-aware UX

9. Stop the web app and unset SMTP_HOST in the env:
   ```
   unset SMTP_HOST  # or comment out in .env
   pnpm --filter @gml/web dev
   ```
10. Open `/login/forgot` in an incognito window. Confirm:
    - The page renders the saffron-soft banner with the literal
      copy "Password reset is unavailable on this deployment."
    - The form is NOT mounted (no `<input type="email">` in the
      page source via `view-source:`).
    - The "← Back to sign in" link is present.
11. POST directly to /api/auth/forgot-password from a curl shell:
    ```
    curl -i -X POST http://localhost:3000/api/auth/forgot-password \
      -H 'Content-Type: application/json' \
      -d '{"email":"test@example.com"}'
    ```
    Confirm 200 in both branches (SMTP set or unset) — the
    no-enumeration contract holds.
12. Set SMTP_HOST=smtp.example.com and reboot. Reload
    `/login/forgot`. The form is back; the banner is gone.

## (C) /admin/transcode-jobs Redis-down banner

13. Visit `/admin/transcode-jobs` as a super_admin. Confirm the
    depth strip shows live counts.
14. Stop Redis:
    ```
    docker compose stop redis
    ```
15. Reload `/admin/transcode-jobs`. Confirm:
    - The banner above the depth strip reads "Live queue depth
      unavailable (Redis is unreachable). The historical job table
      below is still accurate."
    - The banner has `role="alert"` (verify in dev tools).
    - The historical job table below still renders correctly (the
      DB query is unaffected by Redis).
16. Restart Redis. Reload. The banner is gone; the depth strip
    shows live counts again.

## (D) /repo/students name search with audit dedup

17. Visit `/repo/students` as a programme_admin. Confirm the search
    bar renders above the table.
18. Type "kunzang" letter by letter. Each keystroke submits the form
    (after Enter — the bar is a native GET form, no instant-search).
19. Query the audit log for the test user's recent activity:
    ```
    SELECT created_at, action, metadata FROM audit_log
    WHERE user_id = '<your-user-id>'
      AND action IN ('learners.bulk_view', 'learners.search')
      AND created_at > now() - interval '5 minutes'
    ORDER BY created_at DESC;
    ```
    Expected:
    - One `learners.search` row per (user × query × hour) — not
      one per keystroke. If you searched "k", "ku", "kun",
      "kunz", "kunza", "kunzan", "kunzang" you should see SEVEN
      `learners.search` rows (different queries) — but if you
      reload `/repo/students?q=kunzang` ten times in a row, only
      one new `learners.search` row appears.
    - One `learners.bulk_view` row per render (unchanged spec-046
      behaviour).
20. Confirm the metadata column on the `learners.search` rows
    contains `{"q":"kunzang","resultCount":3,"__dedupKey":"q=kunzang|user=<uid>"}`.

## Test gate

21. Run the spec 168 governance suite:
    ```
    pnpm test -- tests/governance/test_168_half_wired_features_finish.test.mjs
    ```
    All assertions green.
22. Run the spec 158 governance suite to confirm the loosened
    assertion still passes:
    ```
    pnpm test -- tests/governance/test_158_repo_search_bars.test.mjs
    ```
    All 15 assertions green.
23. Run the full governance suite — no regression in the 1423-test
    baseline.
