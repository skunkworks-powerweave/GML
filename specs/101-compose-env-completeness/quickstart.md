# Quickstart 101

1. From a fresh checkout: `cp .env.example .env` and confirm the three new keys (`WHATSAPP_APP_SECRET`, `MEDIA_SIGN_SECRET`, `ACME_EMAIL`) appear under their respective section headers with placeholder values.
2. Negative test: blank out `MEDIA_SIGN_SECRET` in `.env` and run `docker compose config` — expect an error message naming `MEDIA_SIGN_SECRET` and refusing to render the config. Repeat for `WHATSAPP_APP_SECRET` and `ACME_EMAIL`.
3. Positive test: fill in real values (or `openssl rand -base64 32` placeholders for the secrets), then `docker compose up -d` — expect a clean boot, and `docker exec gml-lms-app-1 printenv WHATSAPP_APP_SECRET MEDIA_SIGN_SECRET` returns the values you set.
