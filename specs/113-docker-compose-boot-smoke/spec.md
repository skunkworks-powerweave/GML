# Spec 113 — Docker Compose Boot Smoke (Workflow Run 8 Tier F1)

## Why

Run 8 has, by spec 112, hardened every code-side closure: the worker
runs real ffmpeg, compose env is complete, MinIO buckets self-init,
the super_admin bootstraps, the form catalog seeds, WhatsApp ingest
enqueues against the live worker, retention policies tick on cron,
deploys gate on SM-5, backups mirror live exactly, and `/api/health`
fails loud when migrations lag. Every one of those is verified by an
automated governance test against the source tree. **None of them
verify that the seven containers, on a real Linux box with a real
docker daemon, actually boot and converse with each other.** That gap
is the difference between "the code is correct" and "the deployment
worked." Spec 113 closes the gap by producing the operator-facing
manual smoke checklist — the single artifact the IT-side runs on the
VPS after `git pull && ./scripts/deploy.sh` to declare the deploy
successful.

The checklist is *docs-only*. It is not a script we can run in CI,
because the failure modes we care about (container can't pull image,
host kernel missing overlay2, MinIO disk full, Caddy can't bind
:443, browser anti-download chrome behaves correctly under a real
Chromium) only manifest on the deploy host, not in the build agent.
Putting a script in CI would give false confidence; putting a
checklist in the operator's hands makes them look at the box.

## What

Produce `specs/113-docker-compose-boot-smoke/quickstart.md` as a
numbered, copy-pasteable, ordered-list checklist with at least ten
verifiable steps. Each step contains a command (or browser
click-through), the expected observable outcome, and an explicit
pass/fail criterion. The checklist runs end-to-end in roughly fifteen
minutes on a healthy box and roughly an hour when something is wrong
(which is by design — the steps are ordered so the first failure
narrows the search space).

The ten steps, in execution order, are:

1. **Pre-flight gate** — `node scripts/check-restore-drill.mjs` exits
   0 in production (recent drill on file) or self-skips in
   development/staging. Failure means the SM-5 gate would block
   deploy; remediate before continuing.

2. **Boot the stack** — `./scripts/deploy.sh` (or `make deploy`)
   chains the gate, `docker compose up -d`, the 60 s health-wait,
   migrations, and `seed_all.ts`. The terminal prints
   `[deploy] stack is up` within five minutes on a warm cache (image
   pulls may take longer on a cold box).

3. **Seven services healthy** — `docker compose ps` shows postgres,
   redis, minio, tusd, app, worker, and caddy all in `Up (healthy)`
   or `Up` state. The one-shot `minio-init` should have exited 0;
   `docker compose ps -a` shows it as `Exited (0)`.

4. **App health endpoint** — `curl -sS http://localhost/api/health |
   jq` returns top-level `ok:true` AND `migrations.ok:true` AND
   `details.migrations.applied >= details.migrations.expected`. This
   is the spec 110 guard: if migrations didn't apply, this step
   fails loud, not silent.

5. **Browser sign-in** — open `http://localhost/login` in a private
   Chromium window. Sign in as `$SUPER_ADMIN_EMAIL` with the password
   from `.env`'s `SUPER_ADMIN_INITIAL_PASSWORD`. Expected: land on
   `/dashboard` within five seconds. The spec 103 bootstrap guarantees
   the row exists.

6. **Seed verification — schools** — navigate to `/repo/schools` and
   confirm the table has at least ten rows seeded by the Ladakh
   fixtures. If the page is empty, the `seed_all.ts` run in step 2
   did not complete; check `docker compose logs app` for the seed
   trace.

7. **Seed verification — forms catalog** — navigate to `/admin/forms`
   and confirm at least ten `feedback_forms` rows (mentor + mentee +
   observation + miscellaneous). Spec 104's `seed_form_catalog`
   should have idempotently populated these.

8. **WhatsApp ingest (conditional)** — only if `WHATSAPP_*` envs are
   set in `.env`: POST a signed test payload to
   `/api/webhooks/whatsapp` with a fixture video reference. Verify
   that a `video_submissions` row is created with `source='whatsapp'`,
   the BullMQ job appears in worker logs within ten seconds, and a
   small MP4 transitions to `status='ready'` within two minutes.

9. **Anti-download chrome** — open any `/videos/[id]` playback page.
   Right-click on the `<video>` element: the native context menu is
   suppressed. Press `Ctrl+S`: the keydown handler intercepts and
   shows a toast. Both checks confirm specs 040-044's deterrents are
   loaded.

10. **SM-5 enforcement (negative case)** — first, re-run
    `./scripts/deploy.sh` immediately; it should succeed because the
    restore-drill timestamp in `workspace/last_restore_drill.json` is
    minutes old. Second, edit that file's `last_drill_at` to a
    timestamp older than thirty days, then re-run; the deploy script
    must refuse with a clear error citing SM-5 and the staleness
    age. Revert the file before continuing.

The checklist ends with the operator writing a sign-off record to
`workspace/last_smoke.json` with the run timestamp, the operator's
identifier, and which steps passed. Future audits read this file
the way SM-5 reads `workspace/last_restore_drill.json`.

## Why docs-only?

We considered building a Playwright + Docker SDK harness that runs
this in CI nightly. Three reasons we deferred:

1. **TLS termination.** Step 9's browser checks need to run against
   Caddy on :443 with a real certificate; in CI we'd have to bypass
   that, which would mask the most common deploy failure (Caddy
   can't issue an LE cert because port 80 is blocked upstream).

2. **WhatsApp signature.** Step 8 requires the Meta webhook signing
   secret to be real — a fake secret in CI would only test the path
   that the real one would never hit. The value of the step is in
   confirming the real secret is in `.env`.

3. **Operator literacy.** GML's deploy operator is a non-developer
   IT lead. A checklist they can run, screenshot, and email back is
   the right interface for the first six months — once usage
   patterns stabilise we can lift individual steps into automated
   nightly checks.

## Acceptance criteria

- `specs/113-docker-compose-boot-smoke/quickstart.md` exists.
- The file is at least 1500 bytes (substantive).
- It contains at least ten numbered ordered-list items.
- It references `docker compose ps`, `./scripts/deploy.sh`, and
  `/api/health` explicitly.
- All five standard spec-kit files exist.
- `tests/governance/test_113_docker_compose_boot_smoke.test.mjs`
  passes locally with at least five assertions covering the above.

## Non-goals

- No code changes. This spec produces zero TypeScript / SQL / shell.
- No CI integration. The checklist is run by humans on the deploy
  host.
- No automated `workspace/last_smoke.json` writer. The sign-off is
  manual for v1; a future spec can lift it into a small CLI.
- No replacement of `README-IT.md`'s "Manual fallback" section.
  That section is for *debugging a broken deploy*; this checklist
  is for *verifying a working deploy*.
