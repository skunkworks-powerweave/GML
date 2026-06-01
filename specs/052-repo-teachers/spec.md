# Spec 052 — Repository: Teachers index + drill-in

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-7 (Hindi names always optional in render). SM-9 is N/A: `teachers` are adults registered as users, not learner PII; the audit-on-view contract is reserved for `learners` (spec 019). No new schema columns; reads only.

## Overview

Port `LMS GML Frontend/repository.jsx` lines 829-908 — `RepoTeachersIndex` and `RepoTeacherPage` — into two Next.js server-component routes under the authenticated route group. The prototype reads `window.LMS.TEACHERS` / `window.WIKI.SESSIONS` / `window.wikiLookup`. Real implementation replaces those with inline Drizzle queries against the production schema: `teachers` joined to `schools`, `phases`, classroom `sessions`, and `mentorPairings`/`mentors`/`observationCycles` for the drill-in. Visual layout (typography, spacing, CSS tokens, table shape, KV grid) mirrors the prototype 1:1; the surrounding chrome (sidebar/topbar) is supplied by the `(authenticated)/layout.tsx` shell.

## Functional Requirements

- **FR-001**: `apps/web/src/app/(authenticated)/repo/teachers/page.tsx` is an async server component, `export const dynamic = "force-dynamic"`. Calls `auth()` from `@/auth`; redirects to `/forbidden` if the session role is not in `{super_admin, programme_admin, mentor, observer, teacher}`.
- **FR-002**: `/repo/teachers` issues ONE multi-join query: `teachers ⨝ schools ⨝ phases ⨝ sessionCounts ⨝ cycleCounts` with `sessionCounts` and `cycleCounts` built as inline subqueries grouping by `teacherId`. Returns columns: full_name, hindi_name, phone, subject_specialism, school code/name, phase label, sessions count, cycles count. Filters `active = true`; orders by full_name; limit 200.
- **FR-003**: `/repo/teachers` renders the `repository.jsx` RepoTeachersIndex table 1:1 — header chrome (label "Repository" + serif h1 "Teachers" + caption), single card containing a table with columns Name, नाम (Devanagari Hindi), Subject (color-chipped), School (code in mono), Phase, Sessions (right-aligned mono int), Observation cycles (right-aligned mono int), and a trailing chevron column. Each row links to `/repo/teacher/[id]`.
- **FR-004**: SM-7 — Hindi name column renders the Devanagari string with `font-family: var(--deva)` when present; renders `—` (in `--ink-4`) when null. Never crashes on null.
- **FR-005**: `apps/web/src/app/(authenticated)/repo/teacher/[id]/page.tsx` is an async server component, `export const dynamic = "force-dynamic"`. Same role gate as FR-001. Params are awaited (Next 16 async params). On `teachers.id` miss, calls `notFound()`.
- **FR-006**: Detail page issues 5 reads: (a) teacher row, (b) school with zone leftJoin, (c) optional phase row, (d) last 12 `sessions` rows joined to `subjects` + `classes` for the teacher, ordered scheduled_date desc, (e) last 6 `observation_cycles` for the teacher, (f) last 5 `mentor_pairings` joined to `mentors`. Picks the first `active` pairing (or most-recent) for the pairing card.
- **FR-007**: Detail page renders ← back link → "Teacher" label + truncated UUID → serif H1 with full_name + optional Hindi span (SM-7) → caption paragraph "Teaches {subject} at {code} {school name}. Currently in {phase}." → two-column grid 1.6fr / 1fr.
- **FR-008**: Left column = "Sessions taught (N)" card with rows showing date+time (mono), topic/subject, class grade + attendance fraction + duration, and status pill (`planned|in_progress|complete|cancelled`) coloured via lookup.
- **FR-009**: Right column = three stacked cards. (a) Details KV — Subject (chip), School (link to `/repo/school/[id]`), Zone (when present), Phase, Joined phase (when present), Phone (mono), Onboarded (created_at), Status (active chip). (b) Mentor pairing card — link to `/mentorship/[id]` showing mentor name + optional Hindi + base location + quarter chip + meetings count + status pill. (c) Recent observation cycles list — code (mono), topic/kind, status (mono colored) — each row links to `/observation/[id]`.
- **FR-010**: All inline `style={}` use `var(--token)` CSS variables (no hardcoded colors). Type uses `var(--serif)` for H1, `var(--mono)` for codes/numbers, `var(--deva)` for Hindi.
- **FR-011**: No new schema columns, no new dependencies. Uses existing Drizzle (`drizzle-orm`), `@gml/db`, `@gml/db/schema`.

## Acceptance Criteria

- **AC-1**: `apps/web/src/app/(authenticated)/repo/teachers/page.tsx` exists, imports `db` from `@gml/db` and `teachers`, `schools`, `phases`, `sessions as classroomSessions`, `observationCycles` from `@gml/db/schema`.
- **AC-2**: `apps/web/src/app/(authenticated)/repo/teacher/[id]/page.tsx` exists, imports `db`, `teachers`, `schools`, `zones`, `phases`, `sessions as classroomSessions`, `subjects`, `classes`, `mentorPairings`, `mentors`, `observationCycles`. Awaits `params`.
- **AC-3**: Both routes set `export const dynamic = "force-dynamic"` and call `auth()` for role-gating.
- **AC-4**: Both routes use `var(--deva)` for the Hindi name span, and both render the span ONLY when `hindiName` is truthy.
- **AC-5**: The detail page renders a Devanagari Hindi name span next to the English name in the H1 (matching the prototype's RepoTeacherPage line 881).
- **AC-6**: Governance test `tests/governance/test_052_repo_teachers.test.mjs` passes — asserts file existence, Drizzle table imports, `auth()` role gate, `force-dynamic`, Devanagari font, mentor-pairing link, and observation-cycles link.

## Out of scope

- `/repo/school/[id]` (spec 053), `/repo/class/[id]` (spec 048).
- Mutations / forms to edit teacher data — those live in `/admin/data/teachers` (spec 012/013 admin grid).
- Filters or search UX — index returns all active teachers ordered by name.
- Pagination beyond `limit(200)` — production teacher count is ~10-50.
