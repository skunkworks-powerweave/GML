# GML LMS — IT quick reference

**The authoritative deployment document is [`README-deploy.md`](README-deploy.md).**
It carries the Supabase prerequisites, the manual dashboard steps the
application does not work without, the host preparation, sizing, cost, backup
and restore, and the full troubleshooting table. Read it before a first deploy.

This file is the short version: what runs, how to deploy it, and the four or
five things an IT person actually does after go-live. Anything that would be a
second copy of `README-deploy.md` is a pointer instead — two operator documents
that overlap will drift, and drift is what made the previous version of this
file describe a system that no longer existed.

---

## What runs on the box

Four compose services on one EC2 instance. That is the whole stack.

| Service | Role |
|---|---|
| `caddy` | TLS and reverse proxy. The only published ports (80/443). |
| `app` | Next.js — HTML, RSC, API. |
| `worker` | ffmpeg transcoding, queue consumer, periodic sweeps. |
| `migrate` | One-shot. Applies the schema, then exits. `app` and `worker` block on it exiting 0. |

Everything stateful is **Supabase** — database, authentication and object
storage. The box holds no database and no object store, and video bytes never
transit it in either direction: uploads go browser → Supabase Storage, and
playback segments are fetched by the browser from Supabase's CDN through signed
URLs. That is why a 2-vCPU instance is enough for a video product.

The header of [`docker-compose.yml`](docker-compose.yml) records what each
removed service was and why it went. If someone asks where the database
container went, that is the answer, at the source.

## 5-step deploy

```bash
# 0. Prepare the instance: Docker Engine + the Compose plugin, Node 22, pnpm
#    and jq. Copy-paste commands in README-deploy.md 2.5; log out and back in
#    afterwards so the docker group takes effect.

# 1. Supabase: create the Pro project, then do the three dashboard steps in
#    README-deploy.md 2.2. Nobody can sign in until the first one is done, and
#    no real lesson video uploads until the third.

# 2. Pull the release onto the instance
git clone <repo> gml-lms && cd gml-lms   # the repo root IS the app root
chmod +x scripts/*.sh                    # a zip or scp copy can drop the exec bit

# 3. Configure
cp .env.example .env && chmod 600 .env
nano .env        # every REQUIRED key is marked in the file

# 3.5 Check the host and the configuration (read-only)
bash scripts/preflight.sh    # fix every FAIL before step 4

# 4. Deploy
./scripts/deploy.sh          # or: make deploy

# 5. Verify
curl -s https://$DOMAIN/api/health | jq
```

Step 4 runs: the host-toolchain and `.env` checks, the SM-5 restore-drill gate
(skipped, loudly, on a host's first deploy; see Backups below), build, run the
migrations on their own, tag the images that were serving `:previous` (only
those the build changed), `docker compose up -d`, wait for health through
Caddy, seed, verify auth, post-deploy smoke. It does **not** run
`preflight.sh`; that is step 3.5, by hand. Preflight fails when ports 80 and 443
are in use, which is true of every later deploy.

**Migrations are not a separate step you run.** `deploy.sh` runs the `migrate`
service on its own before `docker compose up`, so if a migration fails nothing
is restarted and the previous containers keep serving. (`app` and `worker` also
wait on it through `depends_on`, but a bare `docker compose up -d` recreates
them first -- which is why the script does not rely on that.) Write down the section-gate passwords the seed prints — they are shown
once.

Upgrading is the same command: `git pull && ./scripts/deploy.sh`. Rolling the
application back is `./scripts/rollback.sh`, which restarts `app` and `worker`
from the `:previous` image and does **not** touch the database. See
`README-deploy.md` section 4.

### Manual fallback

When `deploy.sh` aborts and you want to take it apart by hand:

```bash
docker compose run --rm --no-deps migrate   # migrations FIRST; nothing serving is touched
docker compose up -d                        # only once they succeeded: recreates app and worker
docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/seed_all.ts
docker compose run --rm --no-deps migrate pnpm exec tsx scripts/verify-auth.mjs
```

Doing this by hand bypasses the SM-5 restore-drill gate. Only do it on a host
where `./scripts/restore.sh` has run in the last 30 days, or knowingly accept
that risk.

**The one command that does not work.** Older runbooks — and every earlier
version of this file — said to run `docker compose exec app pnpm --filter @gml/db migrate`.
It cannot work and never could: the `app` image is a Next.js standalone build
containing no pnpm, no tsx and no `packages/db`. Schema work runs in the
`migrate` image, which is built for exactly that. If you find that command
written down somewhere, the note is stale, not the system.

## Environment

`.env.example` is reconciled against the code: every variable it lists is read
somewhere, and everything the code reads is listed. Treat it as the reference;
this is only the operator-facing subset.

| Key | Notes |
|---|---|
| `DOMAIN` / `ACME_EMAIL` | The domain must already resolve here before the first deploy — Caddy needs it for the certificate. |
| `DATABASE_URL` | Supabase **session** pooler, port 5432. Not the transaction pooler on 6543. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Project origin and the browser-safe key. |
| `SUPABASE_SECRET_KEY` | Bypasses RLS entirely and can create, ban and delete accounts. Never let it reach a browser. |
| `AUTH_EMAIL_ENABLED` | `false` until SMTP is attached in the Supabase dashboard. See "Accounts and passwords" below. |
| `WHATSAPP_APP_SECRET` | Optional until WhatsApp is switched on. While empty, the webhook refuses **all** traffic (503 `whatsapp_not_configured`) and deploy/preflight report WhatsApp ingest as OFF; everything else works. |
| `WHATSAPP_VERIFY_TOKEN` | A random string you choose; must match what you type into the Meta dashboard during webhook setup. See "WhatsApp Business setup" below. |
| `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` | From Meta. The access token must be a **permanent system-user token**: the dashboard's temporary one expires in 24 hours, and without a valid token videos are recorded but cannot be fetched. See "WhatsApp Business setup" below. |
| `GML_WHATSAPP_NUMBER` | E.164 **with** the leading `+`, e.g. `+919419100001`. Shown on the upload pages as the "send your clip here" hint. |
| `GML_HELPDESK_PHONE` | E.164 **with** the leading `+`, e.g. `+919419100001`, for the in-product Help button's WhatsApp link. Without the `+` the app rejects the value (a SEVERE line in its log) and hides that contact for everyone. |
| `GML_HELPDESK_EMAIL` | mailto target for the same Help button. |
| `WORKER_CONCURRENCY` | **1.** One ffmpeg at `-preset veryfast` saturates both vCPUs; a second starves the web tier sharing the box. |
| `TZ` | IANA zone, `Asia/Kolkata`. Pins the worker's sweeps and audit-log timestamp interpretation. |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_INITIAL_PASSWORD` | **Required on the first deploy**: without them no account exists at all, and `verify-auth` fails the deploy saying so. Read by the seed only while the database has no active `super_admin`: on the first deploy they create the first usable account. Once any active super admin exists they are ignored, so demoting or deactivating that account in `/admin/users` survives every later deploy. Clear `SUPER_ADMIN_INITIAL_PASSWORD` from `.env` after the first deploy. |

## WhatsApp Business setup

WhatsApp is the programme's low-bandwidth video path, and it is switched on
after go-live: until `WHATSAPP_APP_SECRET` is set the webhook refuses all
traffic and everything else works. Switching it on takes the four values
below, all from Meta, and one webhook registration.

1. **App and number.** In Meta for Developers, open the Business app that has
   the WhatsApp product, with the programme's business number added. On
   **WhatsApp > API Setup**, copy the **Phone number ID** into
   `WHATSAPP_PHONE_NUMBER_ID`. It is Meta's opaque id for the number, not the
   number itself; the dialable number goes in `GML_WHATSAPP_NUMBER`.
2. **App secret.** **App settings > Basic > App secret** into
   `WHATSAPP_APP_SECRET`. Every delivery is checked against it
   (`X-Hub-Signature-256`); a wrong value makes each one a 401 with a log line
   naming the variable.
3. **A permanent access token.** The token shown on API Setup expires after
   24 hours, and with an expired token no video can be fetched. In **Business
   settings > Users > System users**, add a system user, assign it the app and
   the WhatsApp account, and generate a token with the
   `whatsapp_business_messaging` and `whatsapp_business_management`
   permissions that never expires. Put it in `WHATSAPP_ACCESS_TOKEN`. The
   worker uses it to download each video and to reply to the sender.
4. **Verify token.** Any long random string you choose, in
   `WHATSAPP_VERIFY_TOKEN`. Meta sends it back once, when the webhook is
   registered.
5. Run `scripts/preflight.sh` (it warns about any of the four still missing),
   then deploy.
6. **Register the webhook.** **WhatsApp > Configuration > Webhook > Edit**:
   callback URL `https://<DOMAIN>/api/webhooks/whatsapp`, verify token as in
   step 4, **Verify and save**. Then, under **Webhook fields**, subscribe to
   **messages** -- without it Meta sends nothing.
7. **Check it end to end.**
   - The handshake, by hand (it must print `12345`; a 403 means the token
     does not match, or is unset, which the app logs):

     ```
     curl "https://<DOMAIN>/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=12345"
     ```

   - `curl -s https://<DOMAIN>/api/health` reports `"whatsapp":"on"`
     (`partial` names what is missing in `details` when `HEALTH_DEBUG=1`).
   - From a teacher's phone whose number is on her teacher record
     (`/admin/data/teachers`), send a short video captioned with her cycle
     code, e.g. `OBS-2026-009`. Within a minute `/admin/whatsapp-log` lists
     it, linked to the cycle, and the phone gets a reply saying so. A row
     marked "awaiting media" prints why; fix the cause and press
     **Retry fetch**.

A sender is recognised by the last ten digits of their number, matched
against the teacher record (`/admin/data/teachers`) or the phone on the
account itself (`/admin/users`), which is where a mentor's or an observer's
number goes: they have no teacher record. A video from a number that matches
nobody, or captioned with a cycle the sender may not add to, is kept for an
admin rather than attached.

## Day-to-day

### Admin surfaces

Reachable from the left rail for `super_admin` and `programme_admin`, or by
typing the URL.

- **`/admin/users`** — create an account, set an initial password, change a
  role, deactivate someone. This is the only way to onboard a teacher, and it
  is where a forgotten password is dealt with. Deactivating ends the user's
  sessions on every device and bans the auth user; the access token already in
  their browser expires on its own, which is why `README-deploy.md` section 2.2b
  tells you to set the token lifetime to 900 seconds.
- **`/admin/quizzes`** — quiz catalog and an in-browser editor for the question
  schema. Fixing a typo in a question does not invalidate existing attempts.
- **`/admin/transcode-jobs`** — queue depth and failed jobs, with **Retry** and
  **Drop**. A job that has exhausted its attempts is dead, not merely failed;
  that distinction is what separates "will retry itself" from "needs a human".
- **`/admin/system-settings`** — programme name, academic-year label, default
  video quality, and which inbox notification types are on globally.
- **`/admin/whatsapp-log`** — every video sent to the WhatsApp number: who sent
  it, the caption and what it was linked to, its status, and — for one whose
  media has not arrived — why (a missing or rejected access token, a Graph
  error), with **Retry fetch**. It also says when the integration is only
  partly configured. Signature failures and the other webhook events are in
  `/admin/audit` under `whatsapp.*` (docs/audit-actions.md).
- **`/admin`** and **`/admin/data/<table>`** — the no-code tables: schools,
  teachers, mentors, pairings, classes, learners, sessions, course outlines,
  resources, RTT modules / lessons / readings / sessions, observation cycles and
  the rest, each with add, edit, delete, **Import CSV** and **Export CSV**. This
  is how a programme's data gets in: a fresh deployment's Repository reads zero
  until it is loaded. CSVs reference parent rows by UUID, which you get from the
  parent's Export CSV (first column `id`); the procedure and a load order are in
  `README-deploy.md` section 3.2.
- **`/observation/new`** — nominate an observation cycle (teacher and observer
  pickers; the code is assigned). The only other way to create one is the
  `observation-cycles` table above, for bulk loads.

### Accounts and passwords

**Self-service password reset is off by default** (`AUTH_EMAIL_ENABLED=false`).
Outbound mail is configured in the Supabase dashboard, not in this application,
and attaching a provider has been deferred to IT. While it is off, the reset
page says plainly that resets go through an administrator — which is true, and
better than accepting an address and promising a message that cannot be sent.

So the procedure is: an administrator sets a password at `/admin/users` and
hands it over; the account holder changes it in Settings. When you do attach a
relay in the Supabase dashboard, set `AUTH_EMAIL_ENABLED=true` and redeploy. No
code change.

**There is no per-account lockout, and you cannot lock or unlock anyone.** The
hand-rolled lockout this file used to document — a counter on the user row, a
timed block, and an admin endpoint to lift it — was deleted along with its
columns. It was a denial-of-service tool in both directions: anyone who knew an
address could block it at will with wrong passwords, the counter never decayed
so a single further guess after expiry re-blocked it indefinitely at one request
an hour, and the distinctive error told a stranger which addresses had accounts.
Sign-in is throttled by the application instead: 10 attempts at one account
from one address, and 100 from one address across all accounts, per 15 minutes.
Supabase Auth rate-limits sign-in too, but per client IP, and every sign-in
reaches it from the app server, so on its own it would be one bucket shared by
the whole deployment. Neither is a flag a stranger can set on someone else's
behalf: the per-account limit only binds the address that made the attempts.
Someone who hits it waits up to 15 minutes. If a user genuinely cannot get in,
set them a new password at `/admin/users`.

### Logs and health

```bash
docker compose ps                # health of each container
docker compose logs -f app
docker compose logs -f worker
curl -s https://$DOMAIN/api/health | jq
```

`/api/health` reports `ok`, `app`, `db`, `storage`, `migrations`,
`migrationsApplied` and `migrationsExpected`, and returns **503** when anything
is false. It used to return 200 with `ok:false`, which meant the container
healthcheck and the deploy script — both of which read only the status code —
called a stack with no schema healthy.

Log rotation is already configured in `docker-compose.yml`: 10 MB × 3 files per
service, about 120 MB across the stack. There is nothing to set up.

## Backups (SM-5)

Supabase Pro covers the database daily with 7-day retention. **It has no backup
product for Storage at all** — the videos are a year of classroom recordings
that cannot be re-made, and if we do not mirror them, nobody does. That is what
`scripts/backup.sh` is for.

Install the backup tools first (`README-deploy.md` section 7: the PostgreSQL
client from PGDG, rclone, the AWS CLI), then:

```cron
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
0 2 * * *  cd /home/ubuntu/gml-lms && bash scripts/backup.sh  >> /var/lib/gml/backup.log 2>&1
0 4 * * 0  cd /home/ubuntu/gml-lms && bash scripts/restore.sh >> /var/lib/gml/drill.log  2>&1
```

`scripts/restore.sh` is the drill: it restores the newest dump into a throwaway
database, asserts the schema and row counts look sane, drops it, and stamps
`workspace/last_restore_drill.json`. The throwaway database is a Postgres
container the drill starts and removes itself; the box has no Postgres server of
its own. A failed drill stamps `"result": "failed"` with the reason.

**When the gate arms.** `deploy.sh` refuses to deploy when that stamp is
missing, older than 30 days, or records a failure, on every deploy **except a
host's first deploy**, when nothing can have been backed up yet. So right after
the first deploy, run `bash scripts/backup.sh && bash scripts/restore.sh` once
by hand, or the second deploy will be refused. The gate is also skipped if
`NODE_ENV` is exported as anything other than `production`; do not do that on
the production box.

Restoring for real is `README-deploy.md` section 7 — and step 4 there, re-doing
the dashboard steps, is the one people miss.

## Data retention

What the system deletes by itself, and what it never deletes. The worker runs
one retention job a day, within the hour after 03:00 UTC (08:30 IST).

| Table | Kept for | Deleted by |
|---|---|---|
| `notifications` | 90 days (SM-8) | the nightly retention job |
| `rate_limits` | 24 hours after the caller's last rate-limit window started | the same nightly job |
| `section_gate_grants` | 24 hours after the grant expired (a grant lasts at most 8 hours) — each row holds the user, the section and the client IP | the same nightly job; rotating a gate also deletes its grants |
| `audit_log` | **forever** — nothing in the running system can delete it (SM-1) | only the manual archive below |

**`rate_limits` holds client IP addresses.** Its keys are the sign-in link
throttle (`login-link:<ip>`) and the section-gate throttle
(`gate:<ip>:<user id>:<section>`). The longest window is 15 minutes; a counter
is deleted once its window started more than 24 hours ago, so an address is
not kept for more than about a day after its last attempt. To run the sweep by
hand: `docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/retention.ts`.

**`audit_log` only grows.** Triggers reject every UPDATE, DELETE and
TRUNCATE, deliberately. The default `/admin/audit` view stays
fast as it grows (it walks `audit_log_created_idx`, migration 0028), but disk
use does not stop. Check it monthly:

```sql
SELECT pg_size_pretty(pg_total_relation_size('audit_log')) AS size, count(*) AS rows,
       min(created_at) AS oldest FROM audit_log;
```

If it ever has to shrink, archiving is a **deliberate, signed-off break of
SM-1**: two people, a written reason, and the export kept with the backups. It
needs the table owner (on Supabase, the `postgres` role) to switch a trigger
off. Be aware that the app, the worker and migrate connect as that same role
today, so what stops an application bug is the triggers, not a missing
privilege. Pick a cut-off, then:

```bash
# 1. Export everything older than the cut-off, and keep this file with the backups.
psql "$DATABASE_URL" -c "\copy (SELECT * FROM audit_log WHERE created_at < '2027-01-01') TO 'audit_log_before_2027-01-01.csv' CSV HEADER"
# 2. Count the rows in the file (minus the header) and in the table; they must match.
psql "$DATABASE_URL" -c "SELECT count(*) FROM audit_log WHERE created_at < '2027-01-01'"
```

```sql
-- 3. Delete in ONE transaction, with the trigger off only inside it, and
--    record that it happened. ALTER TABLE locks audit_log for the duration,
--    which blocks every audited action -- do this in a quiet window.
BEGIN;
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete;
DELETE FROM audit_log WHERE created_at < '2027-01-01';
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete;
INSERT INTO audit_log (action, entity_type, metadata)
VALUES ('audit.archived', 'audit_log',
        '{"before": "2027-01-01", "file": "audit_log_before_2027-01-01.csv"}');
COMMIT;
```

## Security notes (substrate moats)

- **SM-1**: `audit_log` is append-only at the database layer — triggers refuse UPDATE, DELETE and TRUNCATE from every role, so an application bug cannot rewrite or empty history. The app connects as the table owner, which could still disable those triggers on purpose; running it as a non-owner role is what would close that.
- **SM-4 (anti-download)** is **deterrence, not prevention**. Watermarks, signed URLs and suppressed right-click stop casual sharing. Screen capture and proxy interception still work; there is no DRM here. Say so to users rather than implying otherwise.
- **SM-7**: Hindi and Bodhi name fields are always optional — never add a NOT NULL constraint to one.
- **SM-9**: reading the learners table writes an audit row automatically, and bulk CSV export requires `super_admin`.

## Troubleshooting

The full table is `README-deploy.md` section 10. The four that account for most
calls:

| Symptom | Cause | Fix |
|---|---|---|
| Nobody can sign in, correct passwords rejected | The Supabase access-token hook is not enabled | `README-deploy.md` 2.2a. Confirm with `docker compose run --rm --no-deps migrate pnpm exec tsx scripts/verify-auth.mjs`. |
| `/api/health` returns 503 | Read which of `db`, `storage`, `migrations` is false | `docker compose logs migrate` first — it is usually that. |
| Worker unhealthy, videos stuck transcoding | It cannot reach the database, or ffmpeg failed | Check `DATABASE_URL` uses the session pooler (5432); then `/admin/transcode-jobs`. |
| WhatsApp videos not arriving | The integration is off or partly configured, or a secret or token is wrong | `/api/health` reports `whatsapp: off / partial / on` (its `details` name the missing variables), and `/admin/whatsapp-log` says the same. Secret unset: 503 `whatsapp_not_configured` and one `WhatsApp ingest is OFF` log line. Secret wrong: 401, `whatsapp.signature_failed` rows and a log line naming `WHATSAPP_APP_SECRET`. Access token missing or expired: the videos are listed on `/admin/whatsapp-log` as awaiting media, with the reason; fix the token, then **Retry fetch**. Check `docker compose logs app worker`. |

## Support

Internal — contact the Goldenmile platform team.
