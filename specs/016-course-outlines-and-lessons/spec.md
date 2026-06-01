# Spec 016 — Course outlines + outline lessons

**Status:** in_progress · **Date:** 2026-06-01

## Overview

Curriculum spine per subject × grade × term: `course_outlines`. Each outline holds an ordered list of `outline_lessons`. The frontend's `/repo/outlines` index + `/repo/outline/[id]` detail browse these. Classroom sessions (spec 017) reference an outline_lesson.

## Functional Requirements

- **FR-001**: `packages/db/src/schema/outlines.ts` exports `courseOutlines` (table `course_outlines`) and `outlineLessons` (table `outline_lessons`).
  - `course_outlines`: id, `subject_id` FK subjects.id ON DELETE CASCADE, `grade smallint CHECK 1..12`, `term smallint`, `name varchar(200)`, `weeks int CHECK >=1`, `sessions_count int DEFAULT 0`, `owner_teacher_id` FK teachers.id ON DELETE SET NULL nullable, `status varchar(16) DEFAULT 'planned'` (planned|in_progress|complete), `learning_outcomes jsonb DEFAULT '[]'`, timestamps. UNIQUE `(subject_id, grade, term)`.
  - `outline_lessons`: id, `outline_id` FK course_outlines.id ON DELETE CASCADE, `sequence int`, `title varchar(240)`, `week int`. UNIQUE `(outline_id, sequence)`.
- **FR-002**: Barrel export.
- **FR-003**: Two admin entities: `course-outlines` and `outline-lessons`.
- **FR-004**: `0004_outlines_and_lessons.sql`.
- **FR-005**: Governance test asserts both tables + FK + UNIQUE + admin registry entries + migration.

## Out of scope
- Linking sessions to outline lessons (spec 017 wires this)
- Repo `/repo/outline/[id]` view (spec 050)
