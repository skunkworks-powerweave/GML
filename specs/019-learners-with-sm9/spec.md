# Spec 019 — Learners + SM-9 (learner PII access is audit-logged)

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-9 lands fully in this spec (its first applicable entity).

## Overview

`learners` are actual children whom teachers teach (distinct from `teachers`, who are the trained adults). Highly sensitive PII: name + guardian + age + attendance%. SM-9 mandates that every server-side read of learner data writes an `audit_log` entry. Generic `/admin/data/[entity]/page.tsx` is amended to call `recordAudit` for entities marked `piiAudited: true`.

## FRs

- **FR-001**: `packages/db/src/schema/learners.ts` exports `learners` (pgTable `learners`). Columns: id, `class_id` FK classes.id ON DELETE CASCADE, `school_id` FK schools.id ON DELETE CASCADE, `grade smallint CHECK 1..12`, `name varchar(160)`, `age smallint CHECK 3..25 OR NULL`, `guardian varchar(120)`, `roll_number varchar(32)`, `section varchar(8)` (e.g. 'A','B'), `attendance_pct smallint CHECK 0..100 OR NULL`, `active boolean DEFAULT true`, `created_at`, `updated_at`, `deleted_at` (soft delete for PII compliance). Indexes `(class_id)`, `(school_id, grade)`.
- **FR-002**: `apps/web/src/admin/types.ts` adds `piiAudited?: boolean` to `AdminEntity`.
- **FR-003**: `apps/web/src/admin/entities/learners.ts` sets `piiAudited: true`, readRoles `[programme_admin, super_admin]`, mutateRoles `[super_admin]` only.
- **FR-004**: `apps/web/src/app/admin/data/[entity]/page.tsx` amended: when `entity.piiAudited === true`, call `recordAudit({action: '<slug>.view', entityType: slug, metadata: {row_count: rows.length}})` after the DB read. The audit row preserves SM-9 invariant.
- **FR-005**: `0008_learners.sql` migration.
- **FR-006**: Governance test asserts (a) schema + entity + barrel + registry, (b) the admin page contains a `piiAudited` check that calls `recordAudit`, (c) the SM-9 grep gate (extension of spec 011's substrate-moat tests) confirms `recordAudit('learners.view'…)` is reachable from the admin grid.
