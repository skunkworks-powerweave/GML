# Spec 171 — Docs refresh (Workflow Run 16 audit closure)

## Why

The 50-finding code audit at the end of Workflow Run 15 closed cleanly
(163 specs, 1423 tests green, build clean). Run 16 then ran a fresh
sweep over the post-closure tree and turned up a small batch of
follow-up findings: real bugs hiding in plain sight, half-wired
features, polish, build/config hygiene, and **documentation drift**.

This spec is the docs-only slice of Run 16. Three concrete drifts:

1. **`README-IT.md` is stale on admin surfaces.** Four admin pages
   landed during Runs 14-15 (`/admin/quizzes` via spec 120,
   `/admin/transcode-jobs` via spec 162, `/admin/system-settings` via
   spec 124, `/admin/whatsapp-log` via spec 126) and none of them are
   listed in the IT operator's runbook. An on-call operator
   troubleshooting a stuck transcode would have no idea the DLQ
   surface even exists.

2. **`README-IT.md` is silent on the lockout + password-reset
   policies.** Spec 161 shipped the "5 failed attempts in 1 hour →
   1-hour lockout" state machine and a self-service password-reset
   flow gated on SMTP. Neither is documented. An IT operator
   responding to "I can't log in" has no way to know whether to
   wait out the lockout, call the `POST /api/admin/users/[id]/unlock`
   endpoint, or escalate. The README also doesn't document the SMTP
   degradation path (`SMTP_HOST` empty → forgot-password renders an
   "unavailable" banner).

3. **`README-IT.md` env table is incomplete.** Six env keys that the
   running app actually reads — `WORKER_CONCURRENCY`, `TZ`,
   `MINIO_BUCKET`, `GML_WHATSAPP_NUMBER`, `GML_HELPDESK_PHONE`,
   `GML_HELPDESK_EMAIL` — are not in the table. An operator copying
   the table into a config-management tool (Ansible / Salt) would
   miss them.

4. **`docs/audit-actions.md` is woefully incomplete.** The current
   file lists ~14 prefix families with one or two examples each.
   A fresh grep over the source tree finds **40+ distinct dotted-
   notation actions** in live `recordAudit({ action: "..." })` call
   sites. Anyone trying to query the audit log by action name (e.g.
   "show me all the `transcode.*` events from the last week") has no
   way to know which actions actually exist.

5. **`specs/113-docker-compose-boot-smoke/quickstart.md` doesn't
   exercise the new admin surfaces.** The 10-step IT smoke
   checklist predates specs 120 / 124 / 126 / 162. A fresh deploy
   could ship with a broken `/admin/transcode-jobs` route and the
   operator would never know.

6. **`tests/integration/smoke.test.mjs` has 8 probes, all from
   spec 111.** The post-Run-15 admin surfaces aren't smoke-tested
   even at the "does the endpoint return a sane status" level.

## What we ship

Pure documentation. **No source code is touched outside `docs/`,
`README-IT.md`, `specs/113-*/quickstart.md`, and the smoke-test file.**

### `README-IT.md` (EDITED)

Three new sections appended:

- **"New admin surfaces (post-audit closure)"** — bullet list of the
  four new admin pages (`/admin/quizzes`, `/admin/transcode-jobs`,
  `/admin/system-settings`, `/admin/whatsapp-log`) with a sentence
  each describing what they do and which audit actions they emit.
- **"Account lockout policy"** — the "5 strikes in 1 hour →
  1-hour lockout" rules, the `POST /api/admin/users/[id]/unlock`
  super_admin override, and the three audit actions involved
  (`auth.account.locked`, `auth.account.locked_attempt`,
  `auth.account.unlocked`).
- **"Password reset flow"** — `/login/forgot` entry point, SMTP-gated
  rendering (form vs unavailable banner), 30-minute token TTL,
  3/hour per-IP rate limit, audit-action list.

The existing **"Required `.env` keys"** table is extended with six
new rows for `WORKER_CONCURRENCY`, `TZ`, `MINIO_BUCKET`,
`GML_WHATSAPP_NUMBER`, `GML_HELPDESK_PHONE`, `GML_HELPDESK_EMAIL`.
The `SMTP_*` row picks up a one-line note about the forgot-password
degradation path.

### `docs/audit-actions.md` (REWRITTEN)

Replaced wholesale with a comprehensive taxonomy. Each prefix family
gets its own H2 section with a Markdown table listing every action
under that prefix, when it fires, and what metadata is captured.
Prefix families covered (16 active + 1 deferred):

- `auth.*` — credentials + lockout + reset (7 actions)
- `gate.*` — section password flow (6 actions)
- `form.*` — feedback-form runner + admin (6 actions)
- `quiz.*` — quiz runner + admin (2 actions)
- `whatsapp.*` — webhook ingest pipeline (9 actions)
- `transcode.*` — BullMQ + ffmpeg (4 actions)
- `admin.row.*` — generic admin CRUD (4 actions)
- `learners.*` / `mentors.*` — SM-9 PII reads + bulk exports (4)
- `resource.*` / `video.*` — media playback (3 actions)
- `observation.*` — cycle lifecycle (5 actions)
- `mentor.*` — mentorship lifecycle (3 actions)
- `teach_back.*` — teach-back review (1 action)
- `system_settings.*` — platform-wide tunables (2 actions)
- `helpdesk.*` — in-product helpdesk (2 actions)
- `notifications.*` / `user_prefs.*` / `dashboard.*` /
  `quickfind.*` — UI-channel events (4 actions)
- `audit.*` — meta-audit (1 action)
- `anti_download.*` — SM-4 deterrence (4 actions)
- Deferred: `backup.*` / `restore.*` / `pairing.*` / `cycle.*`

### `specs/113-docker-compose-boot-smoke/quickstart.md` (EDITED)

Existing 10-step checklist gets three new sub-steps (7.5, 7.6, 7.7)
covering the three new admin surfaces, and a new step 11 covering
the password-reset flow. The "After all ten steps" sign-off bullet
updated to read "After all eleven steps", and the example
`steps_passed` array updated to include 7.5 / 7.6 / 7.7 / 11.

### `tests/integration/smoke.test.mjs` (EDITED)

Four new test cases appended:

- `smoke 9: GET /admin/quizzes (anon)` — must redirect (302) or 403
- `smoke 10: GET /admin/transcode-jobs (anon)` — same
- `smoke 11: GET /admin/system-settings (anon)` — same
- `smoke 12: GET /login/forgot` — must 200 (public surface)

A shared `assertAuthGated()` helper folds the redirect-or-403
contract into one place. The total fetch-call count is now 12
(was 8). All four new probes follow the existing `skipIfUnreachable`
pattern.

## Acceptance criteria

- `README-IT.md` mentions `/admin/quizzes`, `/admin/transcode-jobs`,
  `/admin/system-settings`, and `/admin/whatsapp-log`.
- `README-IT.md` describes account lockout — the literal strings
  "5" and "1 hour" both appear in the lockout section.
- `README-IT.md` describes the password-reset flow including the
  SMTP gating and the 30-minute token TTL.
- `README-IT.md` env table includes `WORKER_CONCURRENCY`, `TZ`,
  `MINIO_BUCKET`, `GML_WHATSAPP_NUMBER`, `GML_HELPDESK_PHONE`,
  `GML_HELPDESK_EMAIL`.
- `docs/audit-actions.md` exists and contains at least **30
  distinct dotted-notation actions** (i.e. matches of
  `/^\s*\|\s*`[\w.]+\.[\w.]+`\s*\|/` in the markdown tables).
- `specs/113-docker-compose-boot-smoke/quickstart.md` references
  `/login/forgot` AND `/admin/transcode-jobs`.
- `tests/integration/smoke.test.mjs` contains at least **12 fetch
  calls total** (was 8). The new four follow the `skipIfUnreachable`
  pattern so CI without a running stack still passes (skipped).
- All five spec-kit files exist under `specs/171-docs-refresh/`.
- `tests/governance/test_171_docs_refresh.test.mjs` passes with
  at least 8 assertions.

## Non-goals

- **No source-code change.** No `apps/**`, `packages/**`, or
  `scripts/**` file is touched. This is pure docs.
- **No schema delta.** No migration is added. The next migration
  idx remains where the previous spec (162 / DLQ) left it.
- **No new dependencies.** All work is text in markdown files.
- **No rewrite of the existing audit-actions taxonomy by case
  name.** Pre-existing actions keep their case-sensitive name in
  the source code; the docs reflect what's shipped, not what would
  be ideal in a greenfield rewrite.
- **No "fix" of the `whatsapp.context.unmatched` over-emission.**
  The webhook handler emits this action from five different call
  sites with different `metadata.reason` values; the docs file the
  variance under the metadata column. A proper unification is
  out of scope.
- **No new audit actions.** This spec documents what exists; it does
  not introduce new `recordAudit` call sites. Spec 167 (auth-events
  pipeline) and spec 168 (per-user audit timeline) own that surface.
