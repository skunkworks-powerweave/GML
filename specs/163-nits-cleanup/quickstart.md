# Quickstart 163 — NITS cleanup

Five manual smoke checks. None requires anything exotic; total time
under five minutes.

## (A) Worker logger format

1. Boot the worker locally:
   ```
   pnpm --filter @gml/worker dev
   ```
2. Watch stderr. The very first line should match the format:
   ```
   [worker][2026-06-02T...Z][info] online {"redis":"redis://...","concurrency":2}
   ```
3. Grep for any remaining `console.` call:
   ```
   pnpm --filter @gml/worker exec rg "console\." src/
   ```
   Expected output: empty (no matches). Pre-fix there were six calls.
4. Trigger a malformed retention job to exercise the warn path:
   ```ts
   import { retentionQueue } from "@gml/worker/queues";
   await retentionQueue.add("unknownAction", {});
   ```
   Watch stderr for:
   ```
   [worker][...][warn] retention: unknown job name {"name":"unknownAction"}
   ```

## (B) Stale-TODO removed from middleware

5. Grep the middleware for the old phrase:
   ```
   rg "once the auditing middleware lands in spec 010" apps/web/src/
   ```
   Expected output: empty.
6. The replacement comment (referencing `recordAudit` in the API
   handlers as the real SM-1 surface) is at the top of
   `apps/web/src/middleware.ts`. Confirm by reading lines 1-15.

## (C) Rate-limit fail-closed JSDoc

7. Open `apps/web/src/lib/rate-limit.ts` and confirm the top of the
   file carries a multi-paragraph JSDoc block. The block must
   include the literal phrase "FAIL-CLOSED" and a worked example
   showing the correct caller try/catch shape.
8. Stop Redis (`docker compose stop redis`). Trigger any rate-
   limited endpoint (e.g. POST `/api/auth/credentials`). Expect a
   `503` response — NOT a `200` slip-through. (This was already the
   spec 141 contract; the JSDoc just documents it.)
9. Restart Redis. Endpoint returns to normal.

## (D) Retention basename-fallback under symlinks

10. Create a symlink to the retention script:
    ```
    ln -s packages/db/src/scripts/retention.ts /tmp/retention.ts
    ```
11. Run it through the symlink:
    ```
    DATABASE_URL=postgres://... tsx /tmp/retention.ts
    ```
12. Pre-fix this would silently no-op (the entry-point guard would
    fail the strict equality and skip the `main()` call). Post-fix
    the basename fallback catches the symlink case and the script
    runs — you should see the `[SM-8] deleted notifications older
    than ...` line on stdout.

## (E) Topbar — no hardcoded EN remains

13. Grep the Topbar source for the literal string `"EN"`:
    ```
    rg '"EN"' apps/web/src/components/nav/Topbar.tsx
    ```
    Expected output: empty.
14. Sign in as a user with `uiLanguage = "hi"`. The language picker
    chip should show `हि`, not `EN`. Change to `bo` — chip shows
    `བོ`. Switch back to `en` — chip shows `EN` (rendered by the
    LanguagePicker island; the literal here is *in the picker*, not
    in the Topbar).

## Test gate

15. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 163"
    ```
    All assertions green. Full suite (1295 / 1295 pre-spec) still
    passes — the NITS round is internal to comments, logger
    structure, and JSDoc; no test should reach into the modified
    lines except the new spec 163 governance test.
