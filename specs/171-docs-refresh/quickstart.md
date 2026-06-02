# Quickstart 171 — Docs refresh

This is the **reviewer's** quickstart for spec 171. It's a docs-only
spec, so the verification is "read the diffs and confirm the
governance test passes" rather than "boot the app and click around".

## Audience

Anyone reviewing the spec-171 diff: another engineer on the team,
the IT operator who maintains the README, or a future contributor
auditing the audit-actions taxonomy.

## Pre-flight

```bash
cd /path/to/lms-app
git status                # confirm you're on the spec-171 branch
ls specs/171-docs-refresh # confirm all five spec-kit files exist
ls tests/governance | grep 171  # confirm the governance test exists
```

## Step 1: Read the README-IT.md diff

```bash
git diff main -- README-IT.md
```

Expected hunks:

1. **Env table extended.** Six new rows for `WORKER_CONCURRENCY`,
   `TZ`, `MINIO_BUCKET`, `GML_WHATSAPP_NUMBER`, `GML_HELPDESK_PHONE`,
   `GML_HELPDESK_EMAIL`. The `SMTP_*` row picks up a one-line note
   about the `/login/forgot` degradation path.
2. **Three new sections appended after the env table:** "New admin
   surfaces (post-audit closure)", "Account lockout policy",
   "Password reset flow".

Sanity-check: search for the literal phrases below in the diff. All
must appear:

- `/admin/quizzes`
- `/admin/transcode-jobs`
- `/admin/system-settings`
- `/admin/whatsapp-log`
- `5 failed login attempts`
- `1-hour account lockout` (or "1 hour")
- `auth.account.locked`
- `auth.account.locked_attempt`
- `auth.account.unlocked`
- `/login/forgot`
- `30 minutes` (token TTL)
- `3/hour per IP` (or "3 requests per hour per IP")
- `WORKER_CONCURRENCY`
- `GML_HELPDESK_EMAIL`

## Step 2: Read the docs/audit-actions.md diff

```bash
git diff main -- docs/audit-actions.md
```

This file is rewritten wholesale. Expected:

- 16 prefix-family H2 sections (`auth.*`, `gate.*`, `form.*`,
  `quiz.*`, `whatsapp.*`, `transcode.*`, `admin.row.*`,
  `learners.*` / `mentors.*`, `resource.*` / `video.*`,
  `observation.*`, `mentor.*`, `teach_back.*`, `system_settings.*`,
  `helpdesk.*`, `notifications.*` / `user_prefs.*` / `dashboard.*` /
  `quickfind.*`, `audit.*`, `anti_download.*`) plus a "Deferred
  prefixes" section.
- Each section is a Markdown table with three columns: Action,
  Fires when, Metadata captured.
- The "Adding a new action" section at the bottom tells future
  contributors the workflow.

Sanity-check: at least 30 distinct dotted-notation actions appear
in the tables. The governance test enforces this.

## Step 3: Read the spec-113 quickstart diff

```bash
git diff main -- specs/113-docker-compose-boot-smoke/quickstart.md
```

Expected:

- New sub-steps 7.5, 7.6, 7.7 inserted between step 7 (forms seed
  verification) and step 8 (WhatsApp ingest). These cover the
  three new admin surfaces.
- New step 11 appended after step 10 (SM-5 enforcement), covering
  the password-reset flow with SMTP-configured and SMTP-unset
  branches.
- The sign-off section's "After all ten steps" bumped to "eleven
  steps" and the example `steps_passed` array updated to include
  `7.5, 7.6, 7.7, 11`.

Sanity-check: search the diff for `/login/forgot` and
`/admin/transcode-jobs`. Both must appear.

## Step 4: Read the smoke.test.mjs diff

```bash
git diff main -- tests/integration/smoke.test.mjs
```

Expected:

- Header comment updated from "8 distinct fetches" to "12 distinct
  fetches" with provenance.
- New `assertAuthGated(res, path)` helper function.
- Four new test cases: `smoke 9` through `smoke 12`.

Sanity-check: count the `await fetch(BASE + ` occurrences in the
file. There should be at least 12 (each `smoke N` test makes at
least one fetch).

## Step 5: Run the governance test

```bash
pnpm test -- tests/governance/test_171_docs_refresh.test.mjs
```

Expected: green. At least 8 assertions covering:

1. All five spec-kit files exist.
2. plan.md follows the CREATED/EDITED/MIGRATED contract.
3. README-IT.md mentions all four new admin surfaces.
4. README-IT.md describes the lockout policy with "5" and "1 hour".
5. README-IT.md describes the password-reset flow.
6. README-IT.md env table includes all six new keys.
7. docs/audit-actions.md exists with >= 30 distinct actions.
8. specs/113 quickstart references /login/forgot and /admin/transcode-jobs.
9. tests/integration/smoke.test.mjs has >= 12 fetch calls.
10. spec.md mentions both Run 16 and "audit closure".

## Step 6: Confirm the broader test suite still passes

```bash
pnpm test
```

Expected: all 1423 prior tests stay green. The spec-171 governance
test brings the total to 1431+ (depending on the exact assertion
count). No prior test should fail — this spec touches no source
code, only documentation files, and the governance suite does not
re-import the doc files into the application runtime.

## Step 7: (Optional) Run the smoke suite against a live stack

If you have a running app at `http://localhost:3000`:

```bash
SMOKE_BASE_URL=http://localhost:3000 pnpm test:smoke
```

Expected: 12 tests, all pass (or skip if the stack is half-up).
Probes 9-12 exercise the new admin surfaces and the password-reset
entry point.

## What's NOT expected

- **No source code change.** `git diff main -- apps/ packages/
  scripts/` should be empty (or limited to lockfile updates if
  unrelated).
- **No migration.** `ls packages/db/src/migrations/` should be
  unchanged from main.
- **No new dependencies.** `git diff main -- package.json
  apps/web/package.json apps/worker/package.json
  packages/db/package.json` should show only docs / version
  bumps unrelated to this spec.

## Sign-off

Once steps 1-5 are green:

- Add the spec to the ledger (`workspace/ledger.jsonl`) per the
  harness convention.
- Bump `workspace/PROGRESS.md` to mark spec 171 shipped.
- Move on to the next Run-16 follow-up spec.
