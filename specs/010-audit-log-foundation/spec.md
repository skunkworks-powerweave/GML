# Spec 010 — Audit Log Foundation

**Status:** in_progress · **Constitution:** SM-1 (audit log is append-only).

## Overview
Ship the `audit_log` table, the `recordAudit()` write helper, the `withAudit()` server-action wrapper, and the `/admin/audit` viewer.

## User Stories
- **US1**: every server action wrapped with `withAudit({action, entityType})` writes a row on success — fields: user_id, action, entity_type, entity_id, ip, ua, metadata jsonb, created_at
- **US2**: an admin can visit `/admin/audit?action=upload&user=...&from=...` to filter the audit log
- **US3**: SM-1 — DB-level grant revokes UPDATE/DELETE on audit_log. App-level: no Drizzle `update`/`delete` allowed (CI gate in spec 011). Re-runs of dev migrations don't replay the table.

## Functional Requirements
- **FR-001**: `packages/db/src/schema/audit.ts` — `audit_log` table with all columns
- **FR-002**: `apps/web/src/lib/audit.ts` — `recordAudit(input)` + `withAudit(fn, meta)` wrapper
- **FR-003**: `apps/web/src/app/admin/audit/page.tsx` — searchable, paginated viewer (server component)
- **FR-004**: Index on (user_id, created_at desc) + on (entity_type, entity_id)
- **FR-005**: **Deferred**: monthly partitioning, RLS / GRANT REVOKE. Reserved for spec 011 (the substrate-moat tests + the SQL migration that revokes UPDATE/DELETE).
