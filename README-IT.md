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
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | magic-link mail |
| `WHATSAPP_VERIFY_TOKEN` | matches what you set in Meta Business webhook config |
| `WHATSAPP_APP_SECRET` | Meta Business app secret (signs incoming webhooks) |
| `WHATSAPP_ACCESS_TOKEN` | permanent system-user token from Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | the numeric phone-number ID Meta assigns |
| `SUPER_ADMIN_EMAIL` | seed admin account |
| `SUPER_ADMIN_INITIAL_PASSWORD` | seed admin password — change on first login |

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
