# Spec 025 — notifications + SM-8 retention

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** **SM-8 lands here** (notifications retain ≤ 90 days).

## Overview

`notifications` is the per-user feed surfaced as `/inbox` in spec 070. Operational ephemera — not source of truth (audit_log is). Retention 90 days via a scheduled job.

## FRs

- **FR-001**: `packages/db/src/schema/notifications.ts` exports `notifications` table. Indexed for (a) inbox feed `(user_id, read_at, created_at desc)` and (b) retention scan `(created_at)`.
- **FR-002**: `packages/db/src/scripts/retention.ts` deletes rows older than 90 days. Callable via `pnpm --filter @gml/db retention`. Will be wired to a daily BullMQ scheduled job in spec 039.
- **FR-003**: `packages/db/package.json` adds the `retention` script.
- **FR-004**: Migration `0011_user_prefs_and_notifications.sql` (combined with spec 024).
- **FR-005**: Governance test asserts schema + retention script + SM-8 grep gate (retention script exists and references `90`).
