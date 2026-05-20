# Plan 007

Files CREATED:
- `apps/web/src/middleware.ts` — Next.js middleware with route → required-role map
- `apps/web/src/lib/guards.tsx` — `<Guarded>` server component + `requireRole()` helper
- `apps/web/src/app/forbidden/page.tsx` — 403 page
- `apps/web/src/app/dashboard/page.tsx` — minimal authenticated landing
- `packages/shared/src/auth/roles.ts` — `ROLE_RANK` + `hasRole()` utility
- `tests/governance/test_007_rbac_middleware.test.mjs`

Files EDITED:
- `packages/shared/package.json` — add `./auth/*` to exports
- `packages/shared/src/index.ts` — re-export roles
