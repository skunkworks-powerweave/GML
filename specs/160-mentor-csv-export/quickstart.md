# Quickstart 160 — Mentor CSV export

Five manual smoke checks, ~1 minute each.

## (A) Anonymous request → 401 JSON

1. Open a private / incognito window so there's no session cookie.
2. Visit `https://<your-host>/api/admin/data/mentors/export`.
3. Expected: 401 status, body `{"error":"unauthenticated"}`.
   Pre-spec this endpoint didn't exist (404).

## (B) `mentor` role → 403 JSON

4. Sign in as a user whose role is `mentor` (any of the seeded mentor
   accounts under `apps/web/scripts/seed/*` will do).
5. Visit `/api/admin/data/mentors/export` directly (paste URL into
   the address bar).
6. Expected: 403 status, body `{"error":"forbidden"}`.
7. Now navigate to `/repo/mentors`. The "Download CSV" button is
   NOT visible — it's hidden by the role gate in the page.

## (C) `programme_admin` → 200 text/csv

8. Sign out, sign in as a `programme_admin` user.
9. Navigate to `/repo/mentors`. The "Download CSV" button is
   visible in the top right of the page header.
10. Click it. The browser downloads `mentors-YYYY-MM-DD.csv`.
11. Open the CSV. Header row reads:
    `id,name,hindiName,baseLocation,expertiseAreas,pairingsActive`
12. One row per mentor in the seed. `expertiseAreas` is a
    JSON-stringified array (e.g. `["English","Reading"]`).
    `pairingsActive` is an integer count of active pairings.

## (D) `super_admin` → 200 text/csv (same shape)

13. Sign out, sign in as a `super_admin` user.
14. Hit `/api/admin/data/mentors/export`. Same CSV shape as (C).
    Filename includes today's UTC date in YYYY-MM-DD format.

## (E) Method matrix → 405

15. With a valid session (programme_admin or super_admin), open
    DevTools → Console, paste:
    ```js
    fetch('/api/admin/data/mentors/export', { method: 'POST' })
      .then(r => r.json())
      .then(b => console.log(b));
    ```
16. Expected: `{ error: 'method_not_allowed' }` with a 405 status.
17. Same for `PUT`, `DELETE`, `PATCH`.

## Audit check

18. With a `programme_admin` or `super_admin` session, hit the export
    once.
19. Query the audit log:
    ```sql
    SELECT action, entity_type, metadata, created_at
    FROM audit_log
    WHERE action = 'mentors.bulk_export'
    ORDER BY created_at DESC
    LIMIT 5;
    ```
20. Most recent row carries `metadata.rowCount` matching the number
    of data rows in the downloaded CSV.

## Test gate

21. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 160"
    ```
22. All assertions green. Full suite still passes (1295 / 1295
    pre-spec).
