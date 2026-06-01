# Spec 021 — Enum migrations + audit_log.action → varchar(64)

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-1 invariant preserved (append-only enforced by REVOKE + triggers + grep gate; column type orthogonal).

## Overview

Three enum extensions + one type widening to make schema match prototype reality:

1. `section_gate_slug` += `admin` (between `observation` and `tkt`) — frontend gates the audit log on this.
2. `pairing_status` += `review` + `complete` (frontend seed has p04 status=`review`, p09 status=`complete`).
3. `audit_log.action`: drop `audit_action` enum, change column to `varchar(64) NOT NULL`. Supports the prototype's dotted-notation taxonomy (`gate.attempt.fail`, `whatsapp.media.fetched`, `transcode.success`, etc).

## FRs

- **FR-001**: `enums.ts` updated: `sectionGateSlugEnum` gets `admin`, `pairingStatusEnum` gets `review` + `complete`, `auditActionEnum` removed entirely (kept as a doc comment explaining the v2 widening).
- **FR-002**: `audit.ts` updated: `action` column = `varchar("action", { length: 64 }).notNull()`. Exported `AuditAction` type is now `string`.
- **FR-003**: `docs/audit-actions.md` documents the dotted-notation convention + every action prefix in use.
- **FR-004**: Migration `0010_enum_migrations_and_audit_varchar.sql` (drizzle-kit-generated, descriptive name pre-set). Generates `ALTER TYPE ... ADD VALUE`, `ALTER COLUMN action TYPE varchar(64) USING action::text`, `DROP TYPE audit_action`.
- **FR-005**: Governance test asserts (a) enum extensions present, (b) audit_log.action is now varchar(64), (c) `AuditAction = string`, (d) SM-1 invariant intact.
