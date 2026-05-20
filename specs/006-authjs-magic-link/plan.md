# Plan 006

Files EDITED:
- `apps/web/src/auth.ts` — add Nodemailer provider with custom `sendVerificationRequest`
- `apps/web/package.json` — `nodemailer` + `@types/nodemailer` dev

Files CREATED:
- `apps/web/src/app/login/email-link-form.tsx` — separate client component for magic-link form
- `tests/governance/test_006_authjs_magic_link.test.mjs`
