# GML LMS — IT Deployment Guide

**Status:** placeholder. Real 1-page guide lands in spec 069. This stub exists so harness tests pass at spec 001.

## What you will need

- A Linux VPS (≥ 4 vCPU, 8 GB RAM, 1 TB disk on a separate volume).
- Docker Engine 24+ and the Docker Compose v2 plugin.
- A domain name with an A record pointed at the VPS public IP.
- SMTP credentials for magic-link emails (or use Postmark / Mailgun / SES).
- A WhatsApp Business Cloud API number, verified through Meta Business Manager.

## What the final deploy will look like (target, not yet shippable)

```bash
git clone <release-url> gml-lms
cd gml-lms
cp .env.example .env
nano .env                    # fill in DOMAIN, passwords, SMTP, WhatsApp
docker compose up -d
```

Then visit `https://<your-domain>` and log in as `SUPER_ADMIN_EMAIL`.

## Backup & restore

Documented in `docs/operations.md` (placeholder; real content lands in spec 067).

## Support

Internal — contact the GML platform team.
