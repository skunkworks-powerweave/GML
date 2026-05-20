# GML LMS — IT Deployment Guide

Self-hosted Learning Management System for Goldenmile Learning's RTT programme.
Single-host stack: postgres + redis + minio + tusd + app + worker + caddy.

## Prerequisites

- A Linux VPS (≥ 4 vCPU, 8 GB RAM, 1 TB disk on a separate volume for media)
- Docker Engine 24+ and the Docker Compose v2 plugin
- A domain name with A/AAAA records pointing at the VPS public IP (or `localhost` for local testing)
- SMTP credentials for magic-link emails (Postmark / Mailgun / SES / self-hosted)
- A WhatsApp Business Cloud API number, verified through Meta Business Manager (optional but recommended for low-bandwidth video intake)

## First-time deploy

```bash
unzip gml-lms-vX.Y.Z.zip && cd gml-lms
cp .env.example .env
nano .env             # set DOMAIN, POSTGRES_PASSWORD, AUTH_SECRET, MINIO_*, SMTP_*,
                      # WHATSAPP_*, SUPER_ADMIN_*
docker compose up -d
docker compose exec app node packages/db/scripts/migrate.ts   # apply schema
```

Then visit `https://<your-domain>` and log in as `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_INITIAL_PASSWORD`.
Change the password immediately via the admin UI.

## Backup & restore

Documented in `docs/operations.md`. Nightly `pg_dump` + MinIO mirror to a configurable target. Restore drill MUST run every 30 days — the deploy script refuses to start (`scripts/check-restore-drill.mjs`) if the last drill is stale.

## Anti-download — honest disclosure

The system applies multiple anti-download protections: HLS-only video streaming with signed short-lived URLs, PDFs rendered server-side as canvas pages (no raw file URL exposed), CSS `user-select: none`, blocked right-click, username + timestamp watermark overlays, and screenshot warnings. **All of these are deterrence, not prevention.** A determined adversary with screen-capture software, a packet inspector, or developer tools can still extract content. The system raises the cost and visibility of exfiltration; it does not make it impossible. Communicate this clearly to teachers and reviewers — pretending otherwise would harm trust when (not if) a leak happens.

## Confidentiality footer

Every protected page in the app displays the confidentiality footer ("Confidential — internal programme use only. © Goldenmile Learning"). This is enforced as substrate moat SM-6 with a CI gate; pages that omit it fail tests.

## Section passwords

Mentorship, Classroom Observation, TKT, and TTT sections each have their own password gate on top of the user's normal login. Rotate them via the admin UI (Settings → Section Passwords). Grants last 8 hours per user-session by design (SM-2, enforced at the DB layer via `CHECK` constraint).

## Operational runbook (one-pagers in `docs/`)

- `docs/architecture.md` — what runs where
- `docs/operations.md` — backup, restore, monitoring, password rotation
- `docs/substrate-moats.md` — the invariants and their enforcement layers
- `docs/verification.md` — manual smoke tests after every deploy

## Support

Internal — contact the GML platform team.
