# Spec 009 — Section Gate UI

**Status:** in_progress · **Constitution:** SM-2 enforced (8h max) via DB CHECK already in spec 008; this spec wires the user-facing path.

## Overview
`/gate/<slug>` page + server action that verifies the section password against the latest version, writes a `section_gate_grants` row (expires_at = now + 8h), and refreshes the JWT to include the slug in `user.gates`.

## User Stories
- **US1**: redirected to `/gate/mentorship` → enter password → on success → redirected to `next` URL (default `/mentorship`)
- **US2**: 5 wrong attempts in 15 min → 429 with "try again in N minutes" (Redis rate-limit, same util as login)
- **US3**: gate audit events written: `gate_pass`, `gate_fail` (audit_log lands in spec 010 but the action layer already records them in a stub log when audit_log isn't yet table-backed)

## Functional Requirements
- **FR-001**: `apps/web/src/app/gate/[slug]/page.tsx` — server component, validates slug, renders form
- **FR-002**: `apps/web/src/app/gate/[slug]/actions.ts` — server action `verifyGate(slug, password)` — bcrypt-compares against the latest version, inserts grant, audit logs
- **FR-003**: Rate-limit per `(ip, userId, slug)` via existing `rateLimit()` util
- **FR-004**: On success, returns redirect to `next`; on failure, shows "Wrong password" with attempts remaining
- **FR-005**: Page guarded — must be logged in (middleware policy `/gate/:path*` already loggedIn)
