# Spec 015 — Classes (grade × school)

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** N/A (no PII; learners spec 019 handles SM-9).

## Overview

Classes are the unit of "Grade N at School S" — what teachers teach in their classrooms. Many learners (spec 019) belong to a class. Classroom sessions (spec 017) reference a class. The frontend's repository drill-down `/repo/class/[id]` shows a class roster.

## Functional Requirements

- **FR-001**: `packages/db/src/schema/classes.ts` exports `classes` (Drizzle pgTable `classes`). Columns: `id uuid pk`, `school_id uuid FK schools.id ON DELETE CASCADE NOT NULL`, `grade smallint NOT NULL` (CHECK 1..12), `stage varchar(16) NOT NULL` (Primary|Middle|High), `students_count int NOT NULL DEFAULT 0`, `sections_count smallint NOT NULL DEFAULT 1`, `class_teacher_name varchar(160) NULL`, `active boolean NOT NULL DEFAULT true`, `created_at`, `updated_at`. UNIQUE `(school_id, grade)`. Index `(school_id)`.
- **FR-002**: Schema barrel exports `classes` + `Class` type.
- **FR-003**: `apps/web/src/admin/entities/classes.ts` exports `classesEntity` (slug `classes`, readable by all 5 roles, mutable by programme_admin + super_admin).
- **FR-004**: `0003_classes.sql` migration via drizzle-kit; descriptive name applied.
- **FR-005**: Governance test asserts schema + admin entity + migration presence.

## Out of scope
- Mapping classes to subjects (would be a `class_subjects` join — held until learners + outlines are real)
- Learner roster (spec 019)
- Repo `/repo/class/[id]` page (spec 048)
