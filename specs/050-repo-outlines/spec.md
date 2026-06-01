# Spec 050 — Repository · Course outlines (index + detail)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 6 (Repository)

## Overview

Ports `LMS GML Frontend/repository.jsx` lines 565-688 (`RepoOutlinesIndex` and `RepoOutlinePage`) to live Next.js server components backed by the production Drizzle schema. The index lists every `course_outlines` row as a clickable table (Outline / Subject / Grade / Term / Sessions / Weeks / Status). The detail page shows the outline header, learning-outcomes list (numbered), ordered `outline_lessons` table, sessions delivered against the outline, a Details KV sidebar, and a Reading-material sidebar (subject-tagged `resources`). Visual fidelity to the JSX prototype is 1:1: same headings, same `--serif` h1, same table layout, same chip palette for status (`saffron-soft` for `in_progress`, `lichen-soft` for `complete`, `paper-2` for `planned`/`archived`), same two-column 1.6fr / 1fr grid for the detail page.

## Functional Requirements

- **FR-001** — Route `/repo/outlines` (server component, `force-dynamic`) queries `course_outlines` left-joined to `subjects` (name) and `teachers` (full_name + hindi_name as owner). Sorted by `subjects.name` then `course_outlines.grade` then `course_outlines.term`. Limit 200.
- **FR-002** — Each table row links to `/repo/outline/[id]`. Status pill maps via `STATUS_STYLE` lookup with four states (planned, in_progress, complete, archived).
- **FR-003** — Route `/repo/outline/[id]` (server component, `force-dynamic`) loads the single outline row + its subject, owner teacher, ordered `outline_lessons` (sequence ASC), associated `sessions` (where `outline_lesson_id IN (...)`), and subject-tagged `resources` (via `resource_subjects` join). Calls `notFound()` if the outline does not exist.
- **FR-004** — Detail page renders four section cards (Learning outcomes, Lessons table, Sessions delivered, Reading material) plus a Details KV sidebar. Reading material sidebar shows up to 5 entries with kind + pages.
- **FR-005** — Hindi name (SM-7) for owner teacher renders in `var(--deva)` only when present.
- **FR-006** — Status pill component is local to the file; matches mentorship's `STATUS_COLOR` pattern (bg + ink object lookup).
- **FR-007** — Imports use `@gml/db` and `@gml/db/schema` barrels; layout's `auth()` gate covers the route (no extra role check — repository is readable by all authenticated roles).

## Acceptance criteria

- AC-1 — `apps/web/src/app/(authenticated)/repo/outlines/page.tsx` exists and queries `courseOutlines` left-joined to `subjects` and `teachers`. Verified by governance test.
- AC-2 — `apps/web/src/app/(authenticated)/repo/outline/[id]/page.tsx` exists, queries `courseOutlines`, `outlineLessons` (ordered by `sequence`), `sessions` (filtered by `outlineLessonId`), and `resources` joined via `resourceSubjects`. Verified by governance test.
- AC-3 — Status pill lookup covers all four schema-allowed values (planned, in_progress, complete, archived). Verified by governance test regex.
- AC-4 — h1 uses `font-family: var(--serif)` at 28px (matches JSX prototype + mentorship page). Header label uses 10px uppercase 0.08em letter-spacing.
- AC-5 — Hindi name conditional render uses `var(--deva)` font on the owner teacher in the Details sidebar. SM-7 holds.
- AC-6 — No new schema columns, no new dependencies, no TODO / placeholder strings in the routes.

## Audit hooks

None. SM-9 applies only to PII reveal flows (learners spec 054, etc.). Reading curriculum metadata is non-PII.

## Out of scope

- Editing outlines / lessons (admin registry path in spec 016 covers CRUD).
- Linking back from a session to its outline lesson (spec 017 already wires `sessions.outline_lesson_id`).
- Repository sessions index page (spec 052).
