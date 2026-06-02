# Quickstart 165 — CI/CD pipeline

Three smoke checks to confirm the workflow is wired correctly.
Total time: under five minutes (plus one PR cycle to see CI run
green for the first time).

## (A) Verify the workflow YAML parses

1. From the repo root, inspect the workflow file:
   ```
   cat .github/workflows/test.yml
   ```
2. The file must start with `name: test-and-build` and declare
   `on:` with both `push` (branches `main`) and `pull_request`
   triggers, plus a single `jobs.test-and-build` block running on
   `ubuntu-latest`.
3. The step order MUST be: checkout → pnpm setup → node setup →
   install → test → build → typecheck → smoke (lenient).

## (B) Trigger the workflow with a no-op PR

4. Create a throwaway branch and push a comment-only change:
   ```
   git checkout -b spec-165-ci-smoke
   echo "# CI smoke" >> docs/ci-smoke.md
   git add docs/ci-smoke.md
   git commit -m "spec 165 smoke — confirm CI workflow runs"
   git push -u origin spec-165-ci-smoke
   ```
5. On GitHub, open a Pull Request from `spec-165-ci-smoke` against
   `main`. Within ~30 seconds you should see a check named
   `test-and-build / test-and-build` appear at the bottom of the
   PR page with a yellow "Queued" indicator.
6. After ~3-5 minutes (cold cache) or ~1-2 minutes (warm cache),
   the check turns green. Click through to the workflow run page
   to see each of the eight steps green.

## (C) Confirm CI fails when expected

7. On the same branch, intentionally break a governance test:
   ```
   # e.g. flip an assertion in tests/governance/test_163_nits_cleanup.test.mjs
   sed -i 's/spec 163/spec 9999/' tests/governance/test_163_nits_cleanup.test.mjs
   git add tests/governance/test_163_nits_cleanup.test.mjs
   git commit -m "spec 165 smoke — intentionally break a test"
   git push
   ```
8. The CI re-runs on the new commit. The `pnpm test` step should
   now FAIL with a red X. The PR's merge button is automatically
   blocked.
9. Revert the breakage:
   ```
   git revert HEAD --no-edit
   git push
   ```
10. CI re-runs and turns green. The PR is mergeable again.

## (D) Lockfile-drift safety check

11. Add a fake dependency without updating the lockfile:
    ```
    # edit apps/web/package.json, add "left-pad": "^1.3.0" under deps
    # do NOT run pnpm install
    git add apps/web/package.json
    git commit -m "spec 165 smoke — lockfile drift"
    git push
    ```
12. CI re-runs. The `pnpm install --frozen-lockfile` step should
    FAIL with an ERR_PNPM_OUTDATED_LOCKFILE error. This proves the
    gate is catching lockfile drift.
13. Revert the change before merging anything.

## (E) Verify the README

14. Confirm `.github/workflows/README.md` exists and is short (< 10
    lines). The README explains in plain English what the gates
    are and points at this spec.

## Test gate

15. Run the scoped governance suite locally:
    ```
    pnpm test -- --test-name-pattern "spec 165"
    ```
    All assertions green. Full suite (1423+ pre-spec) still
    passes — the CI pipeline file is in `.github/`, not on any
    application path, so no existing governance test reaches into
    the new file except the new spec 165 governance test.
