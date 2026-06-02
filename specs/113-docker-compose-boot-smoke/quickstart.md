# Quickstart 113 — Docker Compose Boot Smoke (IT Operator Checklist)

This is the **manual smoke checklist** the IT operator runs on the
VPS after `git pull && ./scripts/deploy.sh`, before declaring the
deploy successful. Run the steps in order — the first failure
narrows the search space. On a healthy box the checklist takes
roughly 15 minutes. Allow up to an hour if any step fails.

**Prerequisites:**

- You are logged into the VPS as the deploy user (`gml` or similar).
- You are in the repo root (`cd /opt/gml-lms` or wherever the repo
  lives).
- `.env` is filled in (all required vars listed in `.env.example`).
- Docker Engine (or Docker Desktop on a workstation) is running:
  `docker info` succeeds.
- You have a workstation with a browser reachable to the VPS on
  ports 80 and 443.

---

## Checklist

1. **Pre-flight: restore-drill gate.** Run
   `node scripts/check-restore-drill.mjs` from the repo root.
   - Expected on a production host (`NODE_ENV=production`): the
     script reads `workspace/last_restore_drill.json`, confirms the
     `last_drill_at` timestamp is within the last 30 days, and exits
     0 with a one-line confirmation.
   - Expected on a non-production host (development / staging /
     unset): the script prints `[restore-drill] non-prod, skipping`
     and exits 0.
   - **Pass:** exit code 0 (run `echo $?` to confirm).
   - **Fail:** exit code 1 with a message naming `SM-5`. Remediate
     by running a restore drill (`scripts/restore.sh` against a
     scratch host, then update `workspace/last_restore_drill.json`)
     before continuing.

2. **Boot the stack.** Run `./scripts/deploy.sh` (or equivalently
   `make deploy`).
   - Expected: the script logs four phases (`docker compose up -d`,
     `waiting for app health`, `running migrations`,
     `running seed_all orchestrator`) and finishes with
     `[deploy] ... stack is up. Visit https://${DOMAIN}/ ...` within
     five minutes on a warm cache. Cold cache adds time for image
     pulls (postgres, redis, minio, tusd, caddy).
   - **Pass:** the final `stack is up` line prints AND the shell
     exit code is 0.
   - **Fail:** any non-zero exit. Capture `docker compose logs
     --tail=200` for the failing service and escalate to engineering.

3. **All seven services healthy.** Run `docker compose ps`.
   - Expected: a table listing **postgres, redis, minio, tusd, app,
     worker, caddy** — each with status `Up` and (for postgres,
     redis, minio, app, caddy) the suffix `(healthy)`. The one-shot
     `minio-init` should appear in `docker compose ps -a` as
     `Exited (0)`; it is not expected to be running.
   - **Pass:** all seven long-running services say `Up`. Postgres,
     redis, minio, app, and caddy say `Up (healthy)`. `minio-init`
     shows `Exited (0)`.
   - **Fail:** any service in `Restarting`, `Exited (1+)`, or
     `unhealthy`. Run `docker compose logs <service> --tail=200`
     to investigate. Common causes: bad `.env` value, port 80/443
     already bound, MinIO disk full.

4. **App health endpoint returns ok:true.** From the VPS, run
   `curl -sS http://localhost/api/health | jq` (install `jq` with
   `apt-get install jq` if absent, or pipe through `python3 -m
   json.tool`).
   - Expected JSON shape (abbreviated):
     ```json
     {
       "ok": true,
       "db": true,
       "redis": true,
       "minio": true,
       "migrations": true,
       "details": {
         "migrations": { "ok": true, "applied": 14, "expected": 14 }
       }
     }
     ```
   - **Pass:** top-level `ok` is `true` AND `migrations` is `true`
     AND `details.migrations.applied >= details.migrations.expected`.
   - **Fail:** `ok:false`. Read `details` to find which sub-system
     is down. If `details.migrations.error` is `"drizzle migrations
     table not found"`, run `docker compose exec -T app pnpm --filter
     @gml/db migrate` manually and re-curl.

5. **Browser sign-in as super_admin.** On your workstation, open a
   private Chromium window and navigate to
   `http://<your-domain-or-localhost>/login`. Sign in with email
   `$SUPER_ADMIN_EMAIL` and password `$SUPER_ADMIN_INITIAL_PASSWORD`
   (both values from the deploy host's `.env`).
   - Expected: you land on `/dashboard` within five seconds. The
     header shows the super_admin email and a "Sign out" affordance.
   - **Pass:** dashboard loads with no console errors.
   - **Fail:** login form rejects credentials → spec 103 bootstrap
     did not run (re-check `docker compose logs app | grep
     super_admin`). 500 error → check `docker compose logs app
     --tail=100`.

6. **Seed verification: schools (Ladakh fixtures).** While signed
   in, navigate to `/repo/schools`.
   - Expected: a table with at least **10 rows** representing
     Ladakh schools, each with a name, district, and SUS code
     column populated by the spec 084 seed.
   - **Pass:** row count >= 10.
   - **Fail:** empty table or row count < 10. The `seed_all.ts`
     run inside `deploy.sh` did not complete; re-run
     `docker compose exec -T app pnpm --filter @gml/db exec tsx
     packages/db/src/scripts/seed_all.ts` manually and reload.

7. **Seed verification: forms catalog.** Navigate to `/admin/forms`.
   - Expected: a table with at least **10 rows** of `feedback_forms`,
     a mix of mentor / mentee / observation / miscellaneous types,
     seeded by spec 104's `seed_form_catalog.ts`.
   - **Pass:** row count >= 10 and forms span at least three of the
     four expected categories.
   - **Fail:** empty table or fewer than 10 rows. Re-run the seeder
     and re-check; if still empty, inspect `docker compose logs app
     | grep seed_form_catalog`.

7.5. **Admin surface: quizzes catalog.** Navigate to `/admin/quizzes`
   (spec 120 + run-16 audit closure surface).
   - Expected: a table listing at least **1 seeded quiz** if
     `seed_quiz_catalog.ts` ran successfully (the post-Phase-9 seed
     ships a small Ladakh-specific RTT quiz). If no quizzes were
     seeded, the page renders an empty state with a "no quizzes yet"
     message and a link to the admin docs — that is also acceptable.
   - **Pass:** the page returns 200, the layout chrome renders, and
     either at least one row OR the empty-state copy is visible.
   - **Fail:** 500 / 403 / blank. 403 indicates the seeded super_admin
     role lost its assignment (re-check `users.role`). 500 indicates
     a missing `quizzes` table or a server-side render crash — capture
     `docker compose logs app --tail=100`.

7.6. **Admin surface: transcode DLQ.** Navigate to
   `/admin/transcode-jobs` (spec 162 + run-16 closure).
   - Expected: a table listing every `video_submissions` row with
     `transcode_state = 'failed'`. On a freshly-deployed box with no
     failures this is intentionally **empty** — the page should render
     a "no failed transcode jobs" empty state.
   - **Pass:** page returns 200 and either renders failed-job rows
     (each with Retry / Drop buttons) OR the empty-state copy.
   - **Fail:** 500 / 403 / blank. Likely cause: spec 162 migration
     didn't apply the new `transcode_state` enum value. Re-check
     `pnpm --filter @gml/db migrate` ran clean.

7.7. **Admin surface: system settings.** Navigate to
   `/admin/system-settings` (spec 124 + run-16 closure).
   - Expected: a form-style surface listing the singleton
     `system_settings` row. At minimum these fields must be visible
     and populated: **programme name** (e.g. "Ladakh RTT 2026") and
     **academic year** (e.g. "2026-27"). The default video quality
     selector and notification-types checkbox grid should render
     below.
   - **Pass:** page returns 200, programme name and academic year
     are populated (i.e. the spec 124 seed inserted the singleton
     row).
   - **Fail:** empty form / null programme name → spec 124 seed did
     not run. Re-run `pnpm --filter @gml/db exec tsx
     packages/db/src/scripts/seed_system_settings.ts`.

8. **WhatsApp ingest (conditional — skip if WHATSAPP_* unset).**
   Only if `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_ACCESS_TOKEN`, and `WHATSAPP_APP_SECRET` are all set in
   `.env`: POST a signed test payload to
   `http://localhost/api/webhooks/whatsapp` using
   `scripts/test_whatsapp_payload.sh` (or `curl` with the fixture
   from `apps/web/tests/fixtures/whatsapp-video-message.json` and an
   HMAC-SHA256 signature header). Then in two separate shells:
   - Watch `docker compose exec -T postgres psql -U gml -d gml_lms
     -c "SELECT id, source, status FROM video_submissions ORDER BY
     created_at DESC LIMIT 5;"`.
   - Watch `docker compose logs -f worker | grep transcode`.
   - **Pass:** a new `video_submissions` row appears with
     `source='whatsapp'` within ten seconds; the worker log shows
     the BullMQ job picked up within thirty seconds; for a small
     MP4 fixture the status transitions to `ready` within two
     minutes.
   - **Fail:** no row appears (webhook signature mismatch — check
     `WHATSAPP_APP_SECRET`); row appears but worker never picks it
     up (Redis or BullMQ wiring is broken); job runs but status
     stays `processing` past two minutes (ffmpeg failure — check
     worker logs for the `ffmpeg` invocation).

9. **Anti-download chrome.** Open any video playback page
   (`/videos/<some-id>` — pick any row from `/repo/videos`).
   - Right-click on the `<video>` element. Expected: the browser's
     native context menu is suppressed (no Save Video As, no
     Inspect Video). A small toast may briefly appear.
   - Press `Ctrl+S` (or `Cmd+S` on macOS). Expected: the browser's
     Save dialog is intercepted by a keydown handler and a toast
     appears informing the user that downloads are not permitted.
   - **Pass:** both the right-click and Ctrl+S deterrents fire.
   - **Fail:** native menu appears or Save dialog opens. The
     anti-download chrome from specs 040-044 did not load — check
     the browser console for JS errors, then inspect the
     `apps/web/src/components/video/VideoPlayer.tsx` element to
     confirm the event handlers are attached.

10. **SM-5 enforcement (negative case).** Two sub-steps:
    - (a) Re-run `./scripts/deploy.sh` *immediately*. Expected: the
      restore-drill gate sees a fresh timestamp in
      `workspace/last_restore_drill.json` (minutes old) and the
      deploy proceeds normally. **Pass:** deploy exits 0.
    - (b) Manually edit `workspace/last_restore_drill.json` and set
      `last_drill_at` to a timestamp **older than 30 days** (e.g.
      `"2025-01-01T00:00:00Z"`). Re-run `./scripts/deploy.sh`.
      Expected: the deploy script **refuses to continue**, exits
      non-zero, and prints a clear error citing `SM-5` and the
      staleness age (e.g. "restore drill is 152 days old, must be
      within 30 days"). **Pass:** non-zero exit with the SM-5
      citation visible on stderr. **Fail:** the deploy proceeds
      anyway — the SM-5 gate is broken; escalate immediately.
    - **After sub-step (b):** revert
      `workspace/last_restore_drill.json` to the original recent
      timestamp before any further deploys.

11. **Password-reset flow (spec 161 + run-16 closure).** Visit
    `/login/forgot` from a private browser window (no active session).
    - **If `SMTP_HOST` is configured in `.env`:** the page renders the
      reset form. Submit `$SUPER_ADMIN_EMAIL` (or any seeded account's
      email). The form's "we sent you a link" success state should
      appear within two seconds. Check the configured inbox (or the
      SMTP relay's outbound log) for an email landing within ~30s
      with subject containing "Reset your GML LMS password". The link
      should resolve to `/login/reset?token=...`; clicking it opens
      the new-password form. **Pass:** form submits, email arrives,
      reset link works. **Fail:** form returns 503 (Redis outage —
      check `docker compose logs redis`); email never arrives
      (SMTP creds wrong — `docker compose logs app | grep -i smtp`);
      link returns "token expired" immediately (server clock drift —
      check `date` on the VPS, compare to your workstation).
    - **If `SMTP_HOST` is empty / unset:** the page renders a
      "feature unavailable — contact your programme admin" banner
      instead of the form. The form must NOT appear; the endpoint
      must NOT mint a token even if force-posted. **Pass:** banner
      visible, no form, no email. **Fail:** form renders anyway
      (env-detection logic broken — likely `SMTP_HOST` is set but
      empty-string rather than truly unset).

---

## Sign-off

After all eleven steps pass, append a record to
`workspace/last_smoke.json` (create the file if absent) with the
following shape:

```json
{
  "last_smoke_at": "2026-06-02T10:30:00Z",
  "operator": "your.email@example.org",
  "git_sha": "abc1234",
  "steps_passed": [1, 2, 3, 4, 5, 6, 7, 7.5, 7.6, 7.7, 8, 9, 10, 11],
  "notes": "Clean run on prod-vps-01."
}
```

Commit nothing — this file is intentionally `.gitignore`d so it
travels with the deploy host, not the repo. Future audits read it
from the live filesystem.

If any step failed, **do not write the sign-off**. Open an issue
with the step number, the captured logs, and the JSON output of
`/api/health`, and escalate to engineering.
