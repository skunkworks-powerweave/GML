# Tasks 171 — Docs refresh

Numbered, executable task list for spec 171. Each task is a single
Edit / Write operation; no task requires running the app.

## 1. README-IT.md — append three new sections

**File:** `README-IT.md`

1. **Env table extension.** Below the existing `SMTP_HOST` row in
   the "Required `.env` keys" table, add six new rows:
   `MINIO_BUCKET`, `GML_WHATSAPP_NUMBER`, `GML_HELPDESK_PHONE`,
   `GML_HELPDESK_EMAIL`, `WORKER_CONCURRENCY`, `TZ`. The
   `SMTP_HOST` row's notes column picks up a sentence:
   "If `SMTP_HOST` is empty, the password-reset surface degrades
   to a 'feature unavailable' banner (see Password reset flow
   below)."

2. **"New admin surfaces (post-audit closure)" section.** Append
   after the env table. Four bullets, one per surface:
   - `/admin/quizzes` — quiz catalog + JSON editor (spec 120)
   - `/admin/transcode-jobs` — failed-transcode DLQ (spec 162)
   - `/admin/system-settings` — programme name + tunables (spec 124)
   - `/admin/whatsapp-log` — recent WhatsApp ingest events (spec 126)

   Each bullet names the spec, the role gate, the audit actions
   emitted, and the most common operator use case.

3. **"Account lockout policy" section.** Append after the admin-
   surfaces section. Content:
   - 5 failed login attempts in 1 hour → 1-hour account lockout
   - super_admin can clear lockout via `POST /api/admin/users/[id]/unlock`
   - Audit actions: `auth.account.locked`, `auth.account.locked_attempt`,
     `auth.account.unlocked`

4. **"Password reset flow" section.** Append after the lockout
   section. Content:
   - Requires `SMTP_HOST` configured; otherwise `/login/forgot`
     shows the "feature unavailable" banner.
   - Token TTL: 30 minutes.
   - Rate-limited: 3 per hour per IP.
   - Audit actions: `auth.password.reset_requested`,
     `auth.password.reset_failed`, `auth.password.reset_completed`,
     `auth.rate_limit.redis_down`.

## 2. docs/audit-actions.md — rewrite

**File:** `docs/audit-actions.md`

Replace the entire file. New structure:

- One-line intro pinning the regex format.
- "Format conventions" subsection.
- 16 H2 sections, one per prefix family, each with a Markdown
  table (Action | Fires when | Metadata captured).
- "Deferred prefixes" section listing the reserved-but-unwired
  namespaces.
- "Substrate moats" section listing SM-1 / SM-9 / rate-limit
  fail-CLOSED contract.
- "Adding a new action" section at the bottom.

Action coverage (at least 30 distinct dotted actions in the
tables; the actual count is 40+ for headroom).

## 3. specs/113-docker-compose-boot-smoke/quickstart.md — extend

**File:** `specs/113-docker-compose-boot-smoke/quickstart.md`

Three new sub-steps inserted between existing steps 7 and 8:

- **7.5 — Admin surface: quizzes catalog.** Navigate to
  `/admin/quizzes`. Pass: 200, at least one seeded quiz OR
  empty-state copy.
- **7.6 — Admin surface: transcode DLQ.** Navigate to
  `/admin/transcode-jobs`. Pass: 200, table OR empty-state copy.
- **7.7 — Admin surface: system settings.** Navigate to
  `/admin/system-settings`. Pass: 200, programme name + academic
  year populated.

New step 11 appended after step 10:

- **11 — Password-reset flow.** Visit `/login/forgot`. Two
  branches: (a) SMTP configured → reset email arrives, link
  works; (b) SMTP unset → "feature unavailable" banner renders.

Sign-off section's "After all ten steps" → "After all eleven steps".
Example `steps_passed` array → `[1, 2, 3, 4, 5, 6, 7, 7.5, 7.6, 7.7, 8, 9, 10, 11]`.

## 4. tests/integration/smoke.test.mjs — extend

**File:** `tests/integration/smoke.test.mjs`

Header comment updated from "8 distinct fetches" to "12 distinct
fetches" with attribution to spec 171.

New `assertAuthGated(res, path)` helper function inserted before
the new tests. Accepts either a 302/303/307 redirect with a
`/login` or `/forbidden` Location, OR a direct 403 status.

Four new test cases appended:

- `smoke 9: GET /admin/quizzes (anon) redirects to /login or 403s`
- `smoke 10: GET /admin/transcode-jobs (anon) redirects to /login or 403s`
- `smoke 11: GET /admin/system-settings (anon) redirects to /login or 403s`
- `smoke 12: GET /login/forgot returns 200 (public surface)`

Each follows the existing `skipIfUnreachable(t)` pattern so CI
without a running stack skips rather than fails.

## 5. Governance test — write

**File:** `tests/governance/test_171_docs_refresh.test.mjs`

Eight or more assertions:

1. All five spec-kit files (spec.md, plan.md, research.md,
   quickstart.md, tasks.md) exist under `specs/171-docs-refresh/`.
2. `plan.md` follows the CREATED / EDITED / MIGRATED contract.
3. `README-IT.md` mentions `/admin/quizzes`, `/admin/transcode-jobs`,
   `/admin/system-settings`.
4. `README-IT.md` describes the lockout policy with literal "5"
   and "1 hour" / "1-hour".
5. `README-IT.md` describes the password-reset flow with `/login/forgot`
   and "30 minutes".
6. `README-IT.md` env table mentions `WORKER_CONCURRENCY`, `TZ`,
   `MINIO_BUCKET`, `GML_WHATSAPP_NUMBER`, `GML_HELPDESK_PHONE`,
   `GML_HELPDESK_EMAIL`.
7. `docs/audit-actions.md` exists and has at least 30 distinct
   dotted-notation actions (count by regex match across tables).
8. `specs/113-docker-compose-boot-smoke/quickstart.md` references
   `/login/forgot` AND `/admin/transcode-jobs`.
9. `tests/integration/smoke.test.mjs` has at least 12 `fetch(BASE`
   call sites.
10. `spec.md` mentions Run 16 and "audit closure".

## 6. Verification

```bash
pnpm test -- tests/governance/test_171_docs_refresh.test.mjs
pnpm test                       # confirm 1423 prior tests still pass
```

If any governance assertion fails, re-read the spec, fix the docs,
re-run. Do NOT commit until both green.

## 7. Ledger + PROGRESS bump

Append a ledger entry to `workspace/ledger.jsonl` with the spec id,
files-edited list, and a 60-character minimum summary. Bump
`workspace/PROGRESS.md` to mark spec 171 shipped.

## 8. Out of scope (do NOT touch)

- `apps/**` — no source-code change
- `packages/**` — no schema delta
- `scripts/**` — no script change
- `workspace/state.json` — orchestrator-owned
- `workspace/PROGRESS.md` — orchestrator-owned (the harness writes
  this; spec author appends, doesn't rewrite)
