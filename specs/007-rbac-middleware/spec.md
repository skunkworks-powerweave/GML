# Spec 007 — RBAC Middleware

**Status:** in_progress · **Constitution:** related to SM-6 (confidentiality footer applies to protected routes — middleware identifies which routes those are).

## Overview
Wire Next.js middleware + a `<Guarded>` server-component wrapper that enforces the 5-role hierarchy from spec 004. Unauthenticated visits to protected routes redirect to `/login?next=...`; insufficient role returns 403.

## User Stories
- **US1**: visiting `/dashboard` while logged out → redirect to `/login?next=/dashboard`
- **US2**: visiting `/admin/data/teachers` as a `teacher` → 403 page; as `programme_admin` → renders
- **US3**: middleware does NOT do per-DB role lookup (would add latency on Ladakh links) — reads role from JWT directly

## Functional Requirements
- **FR-001**: `apps/web/src/middleware.ts` — runs on `/dashboard/*`, `/admin/*`, `/observation/*`, `/rtt/*`, `/mentorship/*`. Reads Auth.js JWT, checks `role`, redirects/blocks per route policy.
- **FR-002**: `apps/web/src/lib/guards.tsx` — `<Guarded roles=[...]>` server component; `requireRole(roles)` helper.
- **FR-003**: Role hierarchy honoured: `super_admin > programme_admin > {mentor, observer} > teacher`.
- **FR-004**: 403 page at `apps/web/src/app/(auth)/forbidden/page.tsx`.
- **FR-005**: Type-safe `RoleName` exported from `@gml/shared/auth/roles.ts`.
