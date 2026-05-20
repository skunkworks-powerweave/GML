# Research 006

## D-001: Nodemailer provider, not Resend/Postmark adapter
Generic SMTP works against any provider IT picks (Brevo, Postmark, SES, self-hosted). One env-var contract (SMTP_*) instead of per-vendor SDK.

## D-002: 10-min token expiry
Long enough for slow Ladakh mail delivery, short enough to limit replay risk.
