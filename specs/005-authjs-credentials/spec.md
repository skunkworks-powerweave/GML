# Spec 005 — Auth.js Credentials Provider

**Status:** in_progress · **Date:** 2026-05-20 · **Constitution Check:** RBAC enforcement lands in 007; here we only wire identity.

## Overview
Wire Auth.js v5 (next-auth@beta) with the Credentials provider + Drizzle adapter so a user with `email + password_hash` in the `users` table can log in.

## User Stories
**US1**: User with valid email+password gets a JWT session; landing page shows `Hi <name>`.
**Independent Test**: seed a user with bcrypt password; POST `/api/auth/callback/credentials` with form data → 200 + Set-Cookie; GET `/` → "Hi <name>".

**US2**: Invalid password → 401, no session cookie. Rate-limit: 5 attempts/15 min per IP+email via Redis.

## Functional Requirements
- **FR-001**: `apps/web/src/auth.ts` exports the configured Auth.js instance using `@auth/drizzle-adapter` against `@gml/db`.
- **FR-002**: `apps/web/src/app/api/auth/[...nextauth]/route.ts` exposes the standard Auth.js handlers (GET, POST).
- **FR-003**: Credentials provider uses `bcryptjs` to verify the password against `users.passwordHash`.
- **FR-004**: Session strategy `jwt`; JWT carries `userId` + `role` claims.
- **FR-005**: `signIn` callback bumps `users.lastSeenAt`.
- **FR-006**: Rate-limit middleware via `ioredis` — 5 attempts / 15 min per `(ip, email)` tuple; on exceed, return 429.
- **FR-007**: `apps/web/src/app/login/page.tsx` — minimal shadcn-style form with email + password (use plain HTML inputs; shadcn lands in spec 012).

## Independent Test
```powershell
pnpm test                       # 31 + new ≥4 pass
pnpm --filter @gml/web build    # type-checks the auth wiring
```

## Out of scope
- Magic-link / email OTP → spec 006
- Role-based page guards → spec 007
- Forgot-password flow → defer to post-launch (operator can reset via admin UI in 012)
