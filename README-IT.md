# GML LMS — IT Deployment Guide

Spec 093. Production deployment in 5 steps. Estimated time: 30 minutes (mostly waiting on image pulls + DNS propagation).

Self-hosted Learning Management System for Goldenmile Learning's RTT programme.
Single-host stack: postgres + redis + minio + tusd + app + worker + caddy.

---

## Prerequisites

- A Linux VPS (Ubuntu 22.04+ or Debian 12+ recommended)
  - **4 vCPU minimum** (worker bursts to 4 cores during transcode)
  - **8 GB RAM**
  - **1 TB disk** on a separate mount (we recommend `/srv/gml-data`) so video storage grows independently of the OS disk
- Docker Engine 24+ and the Docker Compose v2 plugin
- A domain name with an A record pointing at the VPS public IP (e.g. `lms.goldenmile.org`)
- Open inbound ports: 80, 443
- **SMTP credentials** from a provider (Postmark / Mailgun / SES / Brevo) for magic-link emails
- **WhatsApp Business Cloud API number** verified through Meta Business Manager — with the webhook URL set to `https://<your-domain>/api/webhooks/whatsapp`

## 5-step deploy

```bash
# 1. Pull the release
git clone <release-url> /srv/gml-lms
cd /srv/gml-lms

# 2. Configure
cp .env.example .env
nano .env       # fill in DOMAIN, POSTGRES_PASSWORD, AUTH_SECRET, SMTP_*, WHATSAPP_*, SUPER_ADMIN_EMAIL, SUPER_ADMIN_INITIAL_PASSWORD

# 3. Boot the stack with SM-5 pre-flight + health-wait + migrations + seed (spec 108)
./scripts/deploy.sh        # OR: make deploy
# What this does: checks the SM-5 restore-drill stamp (refuses if older than
# 30 days in production), then `docker compose up -d` (~2 GB first-time pull),
# waits up to 60 s for /api/health to return 200, then runs migrations and the
# spec-104 seed_all orchestrator. Aborts on first failure (set -euo pipefail).

# 4. Verify
curl -sS https://$DOMAIN/api/health    # expect {"ok": true, ...}
```

### Manual fallback

If `./scripts/deploy.sh` aborts halfway and you need to debug the stack step
by step, the original commands the wrapper runs are below. **Note:** running
these by hand bypasses the SM-5 restore-drill gate — only do this on a host
where you've already exercised `./scripts/restore.sh` within the last 30 days
(or you're knowingly accepting the SM-5 risk).

```bash
# 3a. Boot the stack manually (first time will pull ~2 GB images)
docker compose up -d

# 3b. Wait ~60 seconds for postgres to be ready, then run migrations + seed
docker compose exec app pnpm --filter @gml/db migrate
docker compose exec app pnpm --filter @gml/db exec tsx packages/db/src/scripts/seed_all.ts
```

Open `https://<your-domain>` in a browser, sign in as `SUPER_ADMIN_EMAIL`, then immediately change the password from the user pill menu.

## Required `.env` keys

| Key | Notes |
|---|---|
| `DOMAIN` | your-lms-domain.org (no scheme, no trailing slash) |
| `ACME_EMAIL` | for Let's Encrypt cert issuance |
| `POSTGRES_PASSWORD` | random 32+ char string |
| `AUTH_SECRET` | random 64+ char string (`openssl rand -base64 64`) |
| `MEDIA_SIGN_SECRET` | random 32+ char string (signs media URLs) |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | strong creds |
| `MINIO_BUCKET` | bucket name for video originals + HLS renditions (default `gml-media`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | magic-link mail + password reset. If `SMTP_HOST` is empty, the password-reset surface degrades to a "feature unavailable" banner (see Password reset flow below). |
| `WHATSAPP_VERIFY_TOKEN` | matches what you set in Meta Business webhook config |
| `WHATSAPP_APP_SECRET` | Meta Business app secret (signs incoming webhooks) |
| `WHATSAPP_ACCESS_TOKEN` | permanent system-user token from Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | the numeric phone-number ID Meta assigns |
| `GML_WHATSAPP_NUMBER` | human-readable display E.164 (e.g. `+91 99XXX XXXXX`) — shown on the uploads / videos pages as the "send your clip here" hint. Falls back to the Meta phone-number ID if unset, which is harder to read. |
| `GML_HELPDESK_PHONE` | wa.me-ready E.164-without-plus for the in-product Help FAB (spec 032 / 122). Used to deep-link learners into a WhatsApp chat with the programme admin. |
| `GML_HELPDESK_EMAIL` | mailto target for the Help FAB. Same surface, alternate channel. |
| `WORKER_CONCURRENCY` | BullMQ worker concurrency — number of parallel ffmpeg jobs. Defaults to 2, silently clamped into `[1, 16]` per spec 151 (NaN / 0 / 999 all fall back to 2). |
| `TZ` | IANA timezone (e.g. `Asia/Kolkata`). Pins the worker's cron-schedule + audit-log timestamp interpretation on non-UTC hosts. Defaults to whatever the container image baked in (usually UTC). |
| `SUPER_ADMIN_EMAIL` | seed admin account |
| `SUPER_ADMIN_INITIAL_PASSWORD` | seed admin password — change on first login |

## New admin surfaces (post-audit closure)

The Run-15 + Run-16 audit closure added four surfaces under `/admin/*` for
the super_admin / programme_admin roles. They are not advertised in the
nav by default (no left-rail entry) — operators reach them by typing the
URL directly. Surface them in your IT runbook so on-call has a one-line
guide:

- **`/admin/quizzes`** — quiz catalog + JSON editor (spec 120). Lists
  every row in the `quizzes` table. Clicking a row opens an in-browser
  JSON editor for the `schema_json` (questions + correct-answer keys);
  saving writes a `quiz.schema.update` audit row and bumps the
  `updated_at` timestamp. Use this to fix a typo in a question or to
  add a missing answer choice without a full DB migration. Schema
  changes do NOT invalidate existing attempts.

- **`/admin/transcode-jobs`** — failed-transcode dead-letter-queue (DLQ)
  admin (spec 162). Lists every `video_submissions` row stuck in the
  `transcode_failed` state. Two actions per row: **Retry** (re-enqueues
  the job into the BullMQ `transcode` queue — emits
  `transcode.retry_requested`) and **Drop** (marks the row terminal,
  no further retry — emits `transcode.dropped`). Use this when ffmpeg
  is wedged on a malformed input the worker can't auto-recover from.

- **`/admin/system-settings`** — platform-wide tunables surface (spec
  124). Edits the singleton `system_settings` row: programme name (shown
  in the dashboard title + email footer), academic-year label, default
  video quality (480p / 720p), and the `notificationsEnabled` set
  (which inbox notification types are active globally — e.g. mute
  "video.transcoded" if learners complain about noise). Emits
  `system_settings.update` on save; the page-render itself emits
  `system_settings.surface_viewed` for SM-1 visibility into who's been
  poking at the platform knobs.

- **`/admin/whatsapp-log`** — recent WhatsApp ingest events (spec 126).
  Tails the last 100 `audit_log` rows with action starting `whatsapp.*`
  (signature failures, replay-ignores, media fetch results, context
  unmatched). Each row has a "resend to worker" affordance for the
  successfully-ingested cases — useful when the transcode worker was
  down at original-ingest time and the BullMQ job was lost.

## Account lockout policy

GML LMS implements a simple "5 strikes in 1 hour" lockout policy on the
credentials login path (Auth.js). Specifically:

- **5 failed login attempts** (wrong password) on the same email within
  a rolling **1-hour window** automatically locks the account.
- A locked account refuses login for **1 hour** from the lockout
  timestamp — the bcrypt verify is skipped entirely to save CPU and
  to deny a timing oracle for "is this account locked".
- A successful login at any point resets the failed-attempt counter
  to zero and clears any pending lockout.

**To unlock an account before the 1-hour timer expires** (e.g. the
user reset their own password externally and you want them in
immediately): a `super_admin` can `POST /api/admin/users/[id]/unlock`.
The endpoint writes an `auth.account.unlocked` audit row and clears
both `users.failedLoginCount` and `users.lockedUntil`.

The audit-log actions involved:

- `auth.account.locked_attempt` — fires on every login attempt against
  an account that is currently locked (the bcrypt-verify-skipped path).
  Lets ops see the attack pattern: how many post-lockout probes the
  attacker is making.
- `auth.account.locked` — fires once, at the moment the counter
  crosses 5. The follow-on lockout duration is in the metadata
  (`metadata.until`).
- `auth.account.unlocked` — fires when super_admin calls the unlock
  endpoint. `actorId` in the metadata identifies the unlocking admin.

## Password reset flow

GML LMS ships a self-service password reset surface for users on the
credentials login path. The flow is gated on SMTP being configured:

- **If `SMTP_HOST` is set in `.env`:** visiting `/login/forgot` shows
  the reset form. Submitting an email mints a reset token (TTL **30
  minutes**), writes a row to `password_reset_tokens`, and emails the
  user a one-click link. The link points at `/login/reset?token=...`;
  setting a new password there consumes the token and emits an
  `auth.password.reset_completed` audit row. The reset endpoint is
  **rate-limited to 3 requests per hour per IP** to deter token-mint
  spamming and bulk email enumeration.

- **If `SMTP_HOST` is empty / unset:** the `/login/forgot` page renders
  a "feature unavailable — contact your programme admin" banner
  instead of the form. This is the expected behaviour on dev hosts
  without an SMTP relay. The endpoint refuses to mint tokens in this
  state.

The audit-log actions involved:

- `auth.password.reset_requested` — fires when the form is submitted
  with a valid email. The user-facing response is intentionally
  identical for unknown vs known emails (no enumeration oracle).
- `auth.password.reset_failed` — fires on token-mismatch / expired
  / consumed-twice attempts at `/login/reset`.
- `auth.password.reset_completed` — fires once, when the new password
  is set and the token is marked consumed.
- `auth.rate_limit.redis_down` — fires when the per-IP rate-limit
  check throws (Redis outage). The endpoint fails-CLOSED per spec 141
  — no reset email goes out.

## Backups (SM-5)

Nightly cron — add to host crontab:

```cron
0 2 * * *  cd /srv/gml-lms && ./scripts/backup.sh >> /var/log/gml-backup.log 2>&1
```

Monthly restore drill (also required BEFORE every code deploy):

```bash
cd /srv/gml-lms && ./scripts/restore.sh
```

The drill restores the latest backup to a throwaway database, runs sanity SELECTs, then drops it. It writes `workspace/last_restore_drill.json` which the deploy script checks (SM-5 invariant: prod deploys refuse if the drill is older than 30 days).

## Upgrades

```bash
cd /srv/gml-lms
git pull
docker compose pull
docker compose up -d --build
docker compose exec app pnpm --filter @gml/db migrate
```

## Security notes (substrate moats)

- **SM-1**: `audit_log` is append-only at the Postgres layer. Even superusers can't UPDATE/DELETE rows (BEFORE-trigger blocks).
- **SM-4 (anti-download)** is **deterrence, not prevention**. Watermarks + signed URLs + disabled right-click stop casual sharing. Determined screen-capture or proxy interception will still work — there is no DRM here. Communicate this to users.
- **SM-7**: Hindi name fields are always optional. Don't add NOT NULL constraints.
- **SM-9**: Reading the learners table (PII) automatically writes an audit row. Bulk CSV export of learners requires `super_admin`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker compose up` hangs | Image pull on slow connection | Patient — first pull is ~2 GB. Subsequent restarts are seconds. |
| Magic-link emails don't arrive | SMTP creds wrong | Check `docker compose logs app \| grep -i smtp` |
| WhatsApp webhook returns 401 | `WHATSAPP_APP_SECRET` mismatch | Re-copy from Meta Business → App → Basic Settings |
| Video shows "Transcoding…" indefinitely | Worker container crashed or no ffmpeg | `docker compose logs worker` |
| Login lands on /forbidden | User has no role assigned | `docker compose exec postgres psql -U gml gml_lms -c "UPDATE users SET role='programme_admin' WHERE email='...';"` |
| Disk filling up | HLS segments accumulating | `du -sh /var/lib/docker/volumes/gml-lms_minio_data` + retention review |

## Support

Internal — contact the Goldenmile platform team.
