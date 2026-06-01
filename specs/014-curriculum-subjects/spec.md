# Spec 014 — Curriculum subjects

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-1 unaffected; no Hindi field here so SM-7 N/A.

## Overview

Ship the curriculum-side `subjects` table (English / Math / EVS / Hindi / Urdu / Science / SS / Art / Ladakhi Studies). Distinct from RTT-content `rtt_subjects` which models training units inside a phase/term. Curriculum subjects feed every other entity in the repository: classes, course outlines, classroom sessions, resources.

## User Stories

**US1** (Programme admin): visit `/admin/data/subjects` → see the curriculum spine → add "English" with code `ENG`, color `var(--saffron)`, grade range 1-12.
**Independent Test**: `pnpm test` 72 + ≥4 governance tests pass. drizzle-kit `generate` produces no diff after schema + migration are in place. `/admin/data/subjects` route renders without error.

**US2** (Mentor): visit `/repo/subjects` (lands in spec 049) → see browseable subject cards. Spec 014 ships the table + admin grid; the repo view is its own spec.

## Functional Requirements

- **FR-001**: `packages/db/src/schema/subjects.ts` exports `subjects` (Drizzle pgTable `subjects`). Columns: `id uuid pk`, `name varchar(120) UNIQUE NOT NULL`, `code varchar(24) UNIQUE NOT NULL`, `color varchar(16) NULL`, `grades_min smallint NULL` (CHECK 1..12), `grades_max smallint NULL` (CHECK 1..12), `display_order int NOT NULL DEFAULT 0`, `active boolean NOT NULL DEFAULT true`, `created_at`, `updated_at`.
- **FR-002**: Schema barrel exports `subjects` and `Subject` type.
- **FR-003**: `apps/web/src/admin/entities/subjects.ts` exports `subjectsEntity` (slug `subjects`, label "Subjects (curriculum)", readRoles [programme_admin, super_admin, mentor, observer, teacher], mutateRoles [programme_admin, super_admin]).
- **FR-004**: Migration `0002_curriculum_subjects.sql` (or descriptive name) CREATEs the table with the unique constraints + check constraints.
- **FR-005**: Governance test asserts schema export + admin registry entry + migration file presence.

## Independent Test

```powershell
pnpm install
pnpm --filter @gml/db generate   # produces 0002_*.sql for the new subjects table
pnpm test                        # 72 + new ≥4 pass
```

## Out of scope
- Repo `/repo/subjects` page (spec 049)
- Seed data populating English/Math/EVS (spec 086)
- FK references from other tables (added when those tables ship in 015-019)
