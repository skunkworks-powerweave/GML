# Quickstart 113 — Docker Compose Boot Smoke (IT Operator Checklist)

This is the **manual smoke checklist** the IT operator runs on the instance
after `git pull && ./scripts/deploy.sh`, before declaring the deploy
successful. Run the steps in order — the first failure narrows the search
space. On a healthy box the checklist takes roughly 15 minutes. Allow up to an
hour if any step fails.

`scripts/deploy.sh` already runs an automated smoke pass (`pnpm test:smoke`)
against the deployment it just made, and it *fails* rather than skips when it
cannot reach the target. This checklist is the human layer on top: the things a
browser and a pair of eyes can see and an HTTP probe cannot.

**The stack is four compose services:** `migrate` (one-shot schema gate), `app`,
`worker`, `caddy`. Everything stateful — database, authentication, object
storage — is Supabase, off-box. `docker-compose.yml` carries a header explaining
what the stack used to contain and why each of those services went; read it once
so nothing in this checklist is a surprise.

**Prerequisites:**

- You are logged into the instance as the deploy user, in the repo root
  (`cd ~/gml-lms/lms-app` or wherever the repo lives).
- `.env` is filled in and mode `600` — every REQUIRED variable is marked in
  `.env.example`.
- The two Supabase dashboard steps in `README-deploy.md` section 2.2 are done.
  **Nobody can sign in until the access-token hook is enabled**, including the
  administrator the seed creates.
- Docker Engine is running: `docker info` succeeds.
- You have a workstation with a browser that can reach the instance on 80/443.

---

## Checklist

1. **Pre-flight: restore-drill gate.** Run
   `node scripts/check-restore-drill.mjs` from the repo root.
   - Expected on a production host (`NODE_ENV=production`): the script reads
     `workspace/last_restore_drill.json`, confirms the drill timestamp is within
     the last 30 days, and exits 0.
   - Expected on a non-production host: it prints a skip line and exits 0.
   - **Pass:** exit code 0 (`echo $?` to confirm).
   - **Fail:** exit code 1 with a message naming `SM-5`. Remediate by running a
     restore drill (`./scripts/restore.sh`, which stamps the file itself) before
     continuing.

2. **Boot the stack.** Run `./scripts/deploy.sh` (or equivalently
   `make deploy`).
   - Expected: the script logs its phases in order — restore-drill preflight,
     image retag to `:previous`, build, `docker compose up -d`, migrations
     applied, health, seed, verify auth, post-deploy smoke — and finishes with a
     `done. Sign in at https://<your real domain>/` line. Cold cache adds image
     build and pull time.
   - **Pass:** the final `done` line prints AND the shell exit code is 0.
   - **Fail:** any non-zero exit. The script names the phase it died in. Capture
     `docker compose logs --tail=200` for the failing service and escalate.

3. **Schema gate completed.** Run `docker compose ps -a`.
   - Expected: `migrate` shows `Exited (0)`. It is a one-shot job, not a
     long-running service, so it is *supposed* to be stopped.
   - **Pass:** `migrate` exited 0.
   - **Fail:** `migrate` shows a non-zero exit code. `app` and `worker` will not
     have started at all — they block on it through
     `depends_on: service_completed_successfully`, and the previous containers
     are still serving. That is the intended posture, not an outage. Read
     `docker compose logs migrate` for the failing statement.

4. **The three long-running services are healthy.** Run `docker compose ps`.
   - Expected: exactly **`app`, `worker` and `caddy`**, each `Up`, each
     `(healthy)` once its start period has elapsed. `app` and `worker` take up
     to 40 seconds and 30 seconds respectively before their first check counts.
   - **Pass:** all three say `Up`, and none is `Restarting` or `unhealthy`.
   - **Fail:** any service `Restarting`, `Exited`, or still `unhealthy` after
     two minutes. `docker compose logs <service> --tail=200`. A `worker` that is
     up but unhealthy almost always means it cannot reach the database — check
     that `DATABASE_URL` uses the **session** pooler on port 5432, not the
     transaction pooler on 6543.

5. **Health endpoint.** From the instance, run
   `curl -si http://127.0.0.1/api/health` (through Caddy — nothing else
   publishes a port).
   - Expected: **HTTP 200** and a body of this shape:
     ```json
     { "ok": true, "app": true, "db": true, "storage": true,
       "migrations": true, "migrationsApplied": 25, "migrationsExpected": 25 }
     ```
   - The status code and the body must agree. This endpoint returns **503**
     whenever `ok` is false; it used to return 200 with `ok:false`, which made
     both the container healthcheck and the deploy script's readiness wait
     decorative.
   - **Pass:** status 200, `ok` is `true`, and `migrationsApplied` equals
     `migrationsExpected`.
   - **Fail:** 503. Read which of `db`, `storage` or `migrations` is false.
     `migrations:false` means step 3 did not really succeed;
     `storage:false` means the Supabase keys are wrong or the buckets are
     missing (re-running `migrate` creates them).

6. **Sign in as the administrator.** On your workstation open a private window
   and go to `https://<your-domain>/login`. Sign in with `SUPER_ADMIN_EMAIL` and
   `SUPER_ADMIN_INITIAL_PASSWORD` from the instance's `.env`.
   - Expected: you land on `/dashboard` within a few seconds.
   - **Pass:** the dashboard renders and the header shows your account.
   - **Fail:** credentials rejected → the access-token hook is almost certainly
     not enabled (`README-deploy.md` 2.2a); confirm with
     `docker compose run --rm --no-deps migrate node scripts/verify-auth.mjs`,
     which says so in plain words. A 500 → `docker compose logs app --tail=100`.

7. **Seed verification: schools.** Navigate to `/repo/schools`.
   - Expected: at least **10 rows** of Ladakh schools with name, district and
     code populated by the seed.
   - **Pass:** row count >= 10.
   - **Fail:** empty or short. The seed phase of `deploy.sh` did not complete;
     re-run it on its own with
     `docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/seed_all.ts`
     and reload. The seed is idempotent.

8. **Seed verification: forms catalog.** Navigate to `/admin/forms`.
   - Expected: at least **10 rows** of feedback forms spanning mentor, mentee,
     observation and miscellaneous types.
   - **Pass:** row count >= 10 across at least three categories.
   - **Fail:** empty or short — same remediation as step 7, then check
     `docker compose logs app` for the seeder's output.

9. **Admin surfaces render.** Visit each of `/admin/users`, `/admin/quizzes`,
   `/admin/transcode-jobs`, `/admin/system-settings` and `/admin/whatsapp-log`.
   - Expected: each returns 200 with its chrome rendered. On a freshly deployed
     box `/admin/transcode-jobs` and `/admin/whatsapp-log` are legitimately
     **empty** and should say so rather than rendering a blank page.
     `/admin/system-settings` must show a populated programme name and academic
     year — those come from the seed. `/admin/users` must list at least the
     administrator account you signed in as.
   - **Pass:** all five return 200; the two settings values are populated; empty
     surfaces render their empty state.
   - **Fail:** 403 on any of them means the role gate is wrong for your account.
     500 means a missing table or a render crash — `docker compose logs app
     --tail=100`. A blank page with a console CSP error is `docker/Caddyfile`,
     not the application.

10. **Account creation works end to end.** At `/admin/users`, create a throwaway
    account with an initial password, sign into it in a second private window,
    then deactivate it from the first window.
    - Expected: the new account signs in and lands on its role's dashboard.
      After deactivation its sessions end and the password stops working.
    - **Pass:** create, sign in, deactivate all succeed, and the audit log at
      `/admin/audit` shows the create and the role assignment with no password
      material in it.
    - **Fail:** creation returns an error (read it — the surface refuses
      privilege escalation and self-edits deliberately), or a deactivated
      account can still sign in. Note that an access token already issued
      remains valid until it expires; that window is the Supabase token lifetime
      and should be 900 seconds (`README-deploy.md` 2.2b).

11. **Password-reset entry point matches the deployment.** Visit
    `/login/forgot` from a private window with no session.
    - **If `AUTH_EMAIL_ENABLED=false`** (the default, and the expected state
      until IT attaches a relay in the Supabase dashboard): the page renders a
      banner saying password reset is unavailable on this deployment and to
      contact a programme administrator. No form.
    - **If `AUTH_EMAIL_ENABLED=true`:** the form renders and submitting a known
      address triggers Supabase's recovery mail. The response is deliberately
      identical for known and unknown addresses.
    - **Pass:** the page matches the flag actually set in `.env` — banner when
      false, form when true.
    - **Fail:** a form appears while the flag is false. That means the
      deployment is promising a message it cannot send. There is no reset
      endpoint of our own to fall back to; resets go through `/admin/users`.

12. **Anti-download chrome (SM-4).** Open any video playback page from
    `/videos`.
    - Right-click the player: the native context menu should be suppressed.
      Press `Ctrl+S` (or `Cmd+S`): the save dialog should be intercepted and a
      toast shown.
    - **Pass:** both deterrents fire.
    - **Fail:** the native menu or save dialog appears — check the browser
      console for a JS error. Remember what this control is worth: it is
      deterrence, not prevention, and screen capture defeats it by design.

13. **SM-5 enforcement (negative case).** Two sub-steps, in this order:
    - (a) Re-run `./scripts/deploy.sh` immediately. The restore-drill gate sees
      a fresh stamp and the deploy proceeds. **Pass:** exit 0, and it is a
      near-no-op — the schema is already current and the seed skips what exists.
    - (b) Edit `workspace/last_restore_drill.json` and set the drill timestamp
      **older than 30 days**. Re-run `./scripts/deploy.sh`. It must refuse:
      non-zero exit, with an error citing `SM-5` and the staleness.
      **Pass:** non-zero exit with the SM-5 citation on stderr.
      **Fail:** the deploy proceeds anyway — the gate is broken, escalate
      immediately.
    - Restore the original timestamp before any further deploys.

---

## Sign-off

After all thirteen steps pass, append a record to `workspace/last_smoke.json`
(create it if absent):

```json
{
  "last_smoke_at": "2026-06-02T10:30:00Z",
  "operator": "your.email@example.org",
  "git_sha": "abc1234",
  "steps_passed": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  "notes": "Clean run on prod-01."
}
```

Commit nothing — this file is `.gitignore`d on purpose, so it travels with the
deploy host rather than the repo. Future audits read it from the live
filesystem.

If any step failed, **do not write the sign-off**. Open an issue with the step
number, the captured logs, and the body and status code of `/api/health`, and
escalate to engineering.
