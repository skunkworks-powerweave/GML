# Plan 005

Files CREATED:
- `apps/web/src/auth.ts` — NextAuth() with Drizzle adapter + Credentials provider
- `apps/web/src/app/api/auth/[...nextauth]/route.ts` — handler exports
- `apps/web/src/lib/rate-limit.ts` — Redis sliding-window
- `apps/web/src/lib/password.ts` — bcrypt verify
- `apps/web/src/app/login/page.tsx` — server component + form
- `apps/web/src/app/login/actions.ts` — server action wrapping signIn
- `tests/governance/test_005_authjs_credentials.test.mjs`

Files EDITED:
- `apps/web/package.json` — add `next-auth@beta`, `@auth/drizzle-adapter`, `bcryptjs`, `@types/bcryptjs`, `ioredis`, `@gml/db: workspace:*`
- `apps/web/src/app/page.tsx` — landing page reads session, shows `Hi <name>` when present
