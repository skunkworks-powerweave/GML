# Research 171 — Docs refresh

## 1. Inventory: which admin surfaces are missing from `README-IT.md`?

Grep the `apps/web/src/app/(authenticated)/admin/` tree for top-level
directories with a `page.tsx` and cross-reference against the IT
deployment guide.

```text
apps/web/src/app/(authenticated)/admin/
├── audit/             ← spec 116 (audit log viewer)        — already in README
├── data/[entity]/     ← spec 014 + 114 + 152 (CRUD runner) — already in README
├── forms/             ← spec 073 (forms admin)             — already in README
├── gates/             ← spec 010 + 115 + 148 (gates)       — already in README
├── page.tsx           ← spec 012 (admin hub)               — already in README
├── quizzes/           ← spec 120 (quiz admin)              ← MISSING
├── system-settings/   ← spec 124 (platform tunables)       ← MISSING
├── transcode-jobs/    ← spec 162 (DLQ admin)               ← MISSING
└── whatsapp-log/      ← spec 126 (WhatsApp ingest log)     ← MISSING
```

Four missing surfaces. All four shipped during Runs 14-15, none made
it into the operator-facing README. This spec adds them.

## 2. Inventory: which audit actions are missing from
   `docs/audit-actions.md`?

The current file lists ~14 prefix families with 1-2 example actions
each (~25 actions total documented). A grep over the source tree
for live `action: "..."` patterns yields:

```text
$ rg -no '"[a-z_]+(\.[a-z_]+)+"' apps/web/src --type ts | sort -u
```

The match-set includes these previously-undocumented actions:

- `auth.rate_limit.redis_down`        (spec 141, both gate and credentials)
- `auth.account.locked`               (spec 161)
- `auth.account.locked_attempt`       (spec 161)
- `auth.account.unlocked`             (spec 161 + admin unlock)
- `auth.password.reset_requested`     (spec 161)
- `auth.password.reset_failed`        (spec 161)
- `auth.password.reset_completed`     (spec 161)
- `form.draft.save` / `form.draft.clear` (spec 075, form-drafts)
- `form.access.denied`                (spec 155)
- `form.config_error.both_handlers`   (defensive logger)
- `quiz.submit`                       (spec 146)
- `quiz.schema.update`                (spec 120)
- `whatsapp.signature_failed`         (spec 040)
- `whatsapp.message.replay_ignored`   (spec 040)
- `whatsapp.media.url_failed`         (spec 040)
- `whatsapp.media.fetch_failed`       (spec 040)
- `whatsapp.media.fetched`            (spec 040)
- `whatsapp.context.unmatched`        (×5 call sites in webhook)
- `whatsapp.log.surface_viewed`       (spec 126)
- `whatsapp.transcode.resent`         (spec 126)
- `transcode.enqueued`                (spec 040)
- `transcode.retry_requested`         (spec 162)
- `transcode.dropped`                 (spec 162)
- `transcode.dlq.surface_viewed`      (spec 162)
- `admin.row.create` / `.update` / `.delete` (spec 114)
- `admin.row.bulk_delete`             (spec 157)
- `learners.view`                     (spec 048 + SM-9)
- `learners.bulk_view`                (spec 054)
- `mentors.bulk_export`               (spec 160)
- `resource.pdf.view`                 (spec 087)
- `resource.view.client_ping`         (spec 099)
- `video.view`                        (spec 042)
- `observation.pre_form.submitted`    (spec 059)
- `observation.observer_form.submitted` (spec 059)
- `observation.post_form.submitted`   (spec 059)
- `observation.signed_off`            (spec 059)
- `observation.note.added`            (spec 059)
- `mentor.meeting.logged`             (spec 061)
- `mentor.pairing.completed`          (spec 061)
- `mentor.commitment.toggled`         (spec 061)
- `teach_back.reviewed`               (spec 097)
- `system_settings.update`            (spec 124)
- `system_settings.surface_viewed`    (spec 124)
- `helpdesk.ticket_opened`            (spec 122)
- `helpdesk.ticket_rate_limited`      (spec 122)
- `notifications.mark_read`           (spec 096)
- `user_prefs.update`                 (spec 024)
- `dashboard.viewed`                  (spec 127)
- `quickfind.query`                   (spec 121)
- `audit.bulk_export`                 (spec 116)
- `anti_download.attempt.save`        (spec 156, client-side)
- `anti_download.attempt.print`       (spec 156)
- `anti_download.attempt.printscreen` (spec 156)
- `anti_download.devtools.detected`   (spec 156)

That's **40+ distinct dotted-notation actions** in shipped code. The
docs file currently covers ~25, most as illustrative examples rather
than as the canonical taxonomy. This spec rewrites the doc to cover
the full surface area.

## 3. What `recordAudit` call sites are NOT instances of the pattern?

A subtlety: some actions are emitted via wrappers, not raw
`recordAudit({ action: "..." })` calls. Confirmed wrappers:

- `withAudit(...)` — used in `apps/web/src/app/api/...` route helpers
  to fold the audit into the response. Same action-string surface.
- `emitAudit(...)` — used in `apps/web/src/components/AntiDownloadGuard.tsx`
  for the client-side anti-download actions. Routes through
  `/api/audit/resource-view` server-side.

Both wrappers ultimately call `recordAudit`, so the action-string
surface in the docs covers them too.

## 4. What env keys are missing from the README table?

Grep the source tree for `process.env.<NAME>` and cross-reference
against the README's "Required `.env` keys" table:

```text
$ rg 'process\.env\.[A-Z_]+' apps/ -o --no-filename | sort -u
```

Match-set highlights (missing from README):

- `WORKER_CONCURRENCY` — `apps/worker/src/index.ts` (BullMQ
  concurrency, default 2, clamped [1, 16] per spec 151)
- `TZ` — implicit on the worker for cron-schedule + audit-log
  timestamp interpretation
- `MINIO_BUCKET` — in `.env.example` but not in the README table
- `GML_WHATSAPP_NUMBER` — `apps/web/src/app/(authenticated)/uploads/page.tsx`
  + videos page (human-readable display)
- `GML_HELPDESK_PHONE` — `apps/web/src/app/(authenticated)/layout.tsx`
  (Help FAB wa.me deep link)
- `GML_HELPDESK_EMAIL` — same (Help FAB mailto)

This spec adds all six to the table.

## 5. What does the spec-113 quickstart need to cover?

Re-read `specs/113-docker-compose-boot-smoke/quickstart.md`. Steps
1-10 are about boot + health + login + seed verification + SM-5 +
WhatsApp ingest + anti-download. They predate:

- `/admin/quizzes` (spec 120)
- `/admin/transcode-jobs` (spec 162)
- `/admin/system-settings` (spec 124)
- `/login/forgot` (spec 161)

This spec adds three sub-steps (7.5, 7.6, 7.7) for the admin
surfaces and a new step 11 for the password-reset flow.

## 6. Why expose admin surfaces in the IT runbook at all?

These four surfaces aren't linked from the nav by default — they're
"by URL" admin pages. An operator only knows they exist if (a)
they read the spec, or (b) the README tells them. The spec
documentation is for engineers; the README is for the IT operator
on the VPS. Putting the surfaces in the README ensures the
runbook stays current with the shipped product.

## 7. Test surface for the new smoke probes

Existing `tests/integration/smoke.test.mjs` has 8 probes. All four
new admin surfaces follow the same pattern: they're auth-gated
pages, so an anonymous GET MUST either redirect to /login (302)
or return 403 with a /forbidden body. The `/login/forgot` probe
is the odd one out — it's a public page, so it MUST return 200.

The `skipIfUnreachable(t)` pattern is preserved: CI without a
running stack stays green by skipping the entire integration
suite, not by silently passing.

The shared `assertAuthGated()` helper folds the three admin
probes' redirect-or-403 logic into one place. Without it the
three tests would be near-duplicate copy-paste, making future
maintenance painful.

## 8. Risks of a docs-only spec

- **Drift.** The docs we write today will drift again. Mitigation:
  the governance test asserts the file contains at least 30
  distinct dotted-notation actions. A future contributor who adds
  a new action without documenting it doesn't break the test (the
  threshold is 30, currently the file has 40+); but the test
  pins the load-bearing surface area so a future contributor
  can't accidentally *delete* a section.
- **False sense of completeness.** Documenting an action doesn't
  mean it's well-designed. The `whatsapp.context.unmatched`
  over-emission (5 call sites, one action name) is documented as
  a quirk rather than fixed.
- **Smoke-test flakiness.** The four new probes assume the app is
  running at `SMOKE_BASE_URL`. The `skipIfUnreachable` pattern
  keeps them inert on dev / CI hosts without a stack. The
  production smoke run (spec 113 quickstart step 11) is where
  they actually run.

None of these are blockers; all are documented in the spec's
non-goals section.

## 9. What's deliberately deferred to a future spec

- A formal `audit.bulk_export.dry_run` distinction (so an export
  query that returns 0 rows still writes a clean audit row but
  doesn't claim "exported N rows").
- A `pairing.*` namespace unification with `mentor.*` (currently
  both prefix families overlap; the deferred section in the docs
  notes this).
- Per-user audit-timeline viewer (deferred to spec 168).

These are tracked elsewhere — out of scope for the run-16
docs refresh.
