# Quickstart 166 — Build & config hygiene

Five manual smoke checks. None requires anything exotic; total time
under five minutes.

## (A) `.gitattributes` — kill CRLF churn

1. Confirm the file exists at the repo root:
   ```
   ls -la .gitattributes
   ```
2. Verify it declares the LF default:
   ```
   rg "text=auto eol=lf" .gitattributes
   ```
   Expected output: one match (the first non-comment line).
3. On a Windows checkout, run `git status` after a clean clone.
   Pre-fix you'd see modified files (every file with a CRLF in
   the working tree but LF in the index). Post-fix the working
   tree stays clean.

## (B) `.env.example` — six new env-vars documented

4. Diff the file against the previous version:
   ```
   git diff HEAD~1 .env.example
   ```
   Expect six new lines (plus their two section-header comments).
5. Grep for each of the six knobs:
   ```
   rg "^WORKER_CONCURRENCY=" .env.example
   rg "^TZ=" .env.example
   rg "^MINIO_BUCKET=" .env.example
   rg "^GML_WHATSAPP_NUMBER=" .env.example
   rg "^GML_HELPDESK_PHONE=" .env.example
   rg "^GML_HELPDESK_EMAIL=" .env.example
   ```
   Every grep returns one match.
6. Copy `.env.example` to `.env` (don't commit). Confirm the
   `# WhatsApp helpdesk / ingest UX` section is at the bottom
   with the three helpdesk knobs grouped together.

## (C) Root-level scripts — typecheck / migrate / seed:all

7. Run the new typecheck script from the repo root:
   ```
   pnpm typecheck
   ```
   Expected behaviour: pnpm walks every package; only `@gml/db`
   actually runs `tsc --noEmit`; other packages are silently
   skipped because they don't declare a `typecheck` script. Exit
   code 0 if `@gml/db` is clean.
8. Run migrate (without an actual DB connection so it'll error
   on connect — that's fine; we're verifying the script is
   wired correctly):
   ```
   pnpm migrate
   ```
   Expected: the command resolves to `pnpm --filter @gml/db
   migrate` → `tsx scripts/migrate.ts`. The error message (if
   any) comes from `scripts/migrate.ts`, not from "command not
   found" or "no such script".
9. Verify the `seed:all` script:
   ```
   pnpm seed:all --help 2>&1 | head -5
   ```
   Expected: the command resolves and at least begins to run
   `tsx src/scripts/seed_all.ts` (will probably fail on DB
   connection, that's fine).

## (D) ESLint configs for worker + db

10. Lint the worker:
    ```
    pnpm --filter @gml/worker exec eslint src/
    ```
    Expected: ESLint loads `apps/worker/eslint.config.mjs` and
    runs the recommended rules over the worker source. Output
    is either "no issues" or a small list of recommended-rule
    findings — pre-fix this command would print "no config
    found" and exit non-zero.
11. Same for db:
    ```
    pnpm --filter @gml/db exec eslint src/ scripts/
    ```
    Expected: ESLint loads `packages/db/eslint.config.mjs` and
    runs the recommended rules.
12. (Optional, future) Wire a `lint` script into each
    `package.json` so `pnpm -r lint` from the repo root picks
    up the worker + db. Out of scope this spec — just verify
    the underlying ESLint exec works.

## (E) `tsconfig.base.json` — proof of life

13. Confirm the base config exists at the repo root:
    ```
    ls -la tsconfig.base.json
    ```
14. Verify `apps/web` extends it:
    ```
    rg "extends.*tsconfig.base" apps/web/tsconfig.json
    ```
    Expected: one match (the `"extends": "../../tsconfig.base.json"`
    line at the top of the file).
15. Run the web app's typecheck end-to-end:
    ```
    pnpm --filter @gml/web exec tsc --noEmit
    ```
    Expected: exit code 0 (web app type-checks clean with the
    new extends in place). If this fails, the base config has
    drifted from the web app's effective settings — investigate
    the diff before declaring the spec green.

## Test gate

16. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 166"
    ```
    All assertions green.
17. Run the full governance suite to confirm no regression:
    ```
    pnpm test
    ```
    All 1423+ pre-spec tests still pass — the hygiene changes
    don't touch any code path that an existing governance test
    reaches into.
18. Run a clean build to confirm the tsconfig extends doesn't
    break anything:
    ```
    pnpm build
    ```
    Expected: green. (The pre-spec build was already clean per
    the Run 16 ground rules; this confirms the tsconfig change
    didn't introduce a regression.)
