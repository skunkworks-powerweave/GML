# Spec 008 — Section Gates Table

**Status:** in_progress · **Constitution:** SM-2 (grants expire ≤ 8h) — DB CHECK is the first enforcement layer.

## Overview
Land the `section_gates` + `section_gate_grants` schema in `@gml/db`, wire middleware to check for a valid grant on protected URL prefixes, and add the `audit_log` schema reservation (table created in spec 010).

## User Stories
- **US1**: visiting `/mentorship/*` without a valid grant → redirect to `/gate/mentorship`
- **US2**: an admin rotates the mentorship password — existing 8h grants keep working until expiry; new visitors must re-enter
- **US3**: SM-2 enforced at DB layer — `section_gate_grants.expires_at <= section_gate_grants.granted_at + interval '8 hours'`

## Functional Requirements
- **FR-001**: `packages/db/src/schema/gates.ts` — `section_gates` (id, slug, password_hash, version, rotated_at, rotated_by_user_id) + `section_gate_grants` (id, user_id, gate_slug, granted_at, expires_at, ip)
- **FR-002**: CHECK constraint on grants: `expires_at <= granted_at + interval '8 hours'`
- **FR-003**: Middleware extension at `apps/web/src/middleware.ts` — after RBAC, check for active grant when path matches a gated prefix
- **FR-004**: `apps/web/src/lib/gates.ts` — `getActiveGrant(userId, slug)` helper
- **FR-005**: Index `section_gate_grants_user_slug_idx` on (user_id, gate_slug, expires_at desc) for fast lookup
