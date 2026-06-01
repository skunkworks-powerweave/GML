# Spec 049 — Repository · Subjects (index + detail)

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 6 · Repository (046-056)

## Overview

Port the **Subjects** surfaces from the `repository.jsx` prototype to two
Next.js server routes under `(authenticated)/repo/`:

1. **`/repo/subjects`** — index. A simple table of curriculum subjects
   (English, Math, EVS, Hindi, Urdu, Science, Social Studies, Art, Ladakhi
   Studies, …) with per-row roll-ups: outlines count, sessions count,
   readings count, grades range.
2. **`/repo/subject/[id]`** — detail. A 4-stat summary header, a course
   outlines table (grouped by grade × term), recent sessions table, reading
   material table, and a small "teachers who teach this subject" panel.

The prototype reads from `window.WIKI.SUBJECTS / OUTLINES / SESSIONS /
RESOURCES`; this spec replaces those globals with Drizzle queries against
the production schema (`subjects`, `course_outlines`, `sessions`,
`resources`, `resource_subjects`, `teachers`). The visual layout matches
the JSX 1:1 — page-header label, serif H1, ink-3 sub-paragraph, table.t
rows with chev → on click, status chip with saffron/lichen for
in_progress/complete, mono small dates.

## Functional Requirements

- **FR-001 — Index route exists.** `apps/web/src/app/(authenticated)/repo/subjects/page.tsx` is a server component with `export const dynamic = "force-dynamic"`. Calls `auth()` and redirects unauth users to `/login`.
- **FR-002 — Index roll-up query.** SELECT id, name, color, gradesMin, gradesMax from `subjects` (active=true), then in parallel: COUNT(course_outlines) grouped by subject_id, COUNT(sessions) grouped by subject_id, COUNT(resource_subjects) grouped by subject_id. Result is sorted by `subjects.displayOrder ASC, name ASC`. Single SQL round-trip preferred; grouped counts via `sql<number>` aggregates.
- **FR-003 — Index table.** Renders columns `Subject | Grades | Outlines | Sessions | Readings | (chev)` exactly per JSX lines 458-477. Subject cell shows a colored dot using the subject's `color` value (CSS var like `var(--saffron)` or hex) followed by the subject name. Grades cell is mono fontSize:12 showing `${gradesMin}–${gradesMax}`. Row is wrapped in `<Link href="/repo/subject/${id}">` for navigation. If no subjects: render placeholder.
- **FR-004 — Detail route exists.** `apps/web/src/app/(authenticated)/repo/subject/[id]/page.tsx` is a server component. `params: Promise<{ id: string }>`. Looks up the subject; calls `notFound()` if absent.
- **FR-005 — Detail header.** `← Subjects` back link → `/repo/subjects`. `Repository · Subject` label. Serif h1 of `subject.name`. Sub-paragraph: `Grades {min}–{max} ({count} grades). FLN-aligned for foundational grades; SCERT framework for higher classes.`
- **FR-006 — Detail stats strip.** A 4-column grid of small stat tiles: `Grades covered | Course outlines | Sessions | Readings`. Card-hi background, var(--line) border, var(--r-3) radius, padding 12.
- **FR-007 — Course outlines section.** Card titled `Course outlines (N) — By grade and term`. Table.t columns `Outline | Grade | Term | Sessions | Weeks | Status | (chev)`. Status uses the saffron/lichen chip mapping (`in_progress` → saffron-soft pill, `complete` → lichen-soft pill, otherwise neutral pill). Rows sorted by grade ASC, term ASC. Each row links to `/repo/outline/${id}`.
- **FR-008 — Recent sessions section.** Card titled `Recent sessions (N)`. Table.t columns `Date | School | Grade | Topic | Teacher | Status` for the most recent 8 sessions joined to schools+classes+teachers. Status chip uses the same planned/in_progress/complete colors as observation Tier-0. Hindi teacher name shown in deva font when present (SM-7).
- **FR-009 — Readings section.** Card titled `Reading material (N)`. Table.t columns `Title | Kind | Owner | Pages | (chev)`. Sourced via `resource_subjects` join. Rows link to `/repo/resource/${id}`.
- **FR-010 — Teachers section.** A compact list of distinct teachers who have at least one session for this subject (max 12). Each shows full name + Hindi name (when present) + school code. Sourced via the `sessions.teacherId → teachers` join, DISTINCT.

## Acceptance Criteria

- **AC-1 → JSX:443-484** — Subject index table renders subjects + per-row roll-up counts. Each row clickable.
- **AC-2 → JSX:489-560** — Subject detail renders 4-stat strip + outlines table + sessions table + readings table, in the same order.
- **AC-3** — `var(--serif)` for H1, `font-family: var(--mono)` for date and grades-range cells, `var(--deva)` for Hindi teacher names where shown.
- **AC-4 — Hindi optional (SM-7).** Hindi teacher name only renders when `teachers.hindiName IS NOT NULL`.
- **AC-5** — Both routes use `auth()` and force-dynamic. No client state, no useEffect, no `window.*` references.
- **AC-6 — Governance test green.** `tests/governance/test_049_repo_subjects.test.mjs` passes asserting routes exist, contain `subjects`/`courseOutlines`/`sessions`/`resourceSubjects` Drizzle references, force-dynamic, and the JSX-equivalent UI strings (`Course outlines`, `Reading material`, `Subjects`).

## Audit hooks

None. Subjects + outlines + readings on the curriculum side are not
PII-bearing per SM-9; only spec 048 (class roster) and 054 (learner detail)
take the audit hit. This spec is read-only / non-PII.

## Out of scope

- Editing subjects (admin/registry covers CRUD via spec 014).
- Outline detail page (spec 050).
- Resource detail page (spec 052).

## Files

- CREATE `apps/web/src/app/(authenticated)/repo/subjects/page.tsx`
- CREATE `apps/web/src/app/(authenticated)/repo/subject/[id]/page.tsx`
- CREATE `tests/governance/test_049_repo_subjects.test.mjs`
- CREATE 5 spec-kit files under `specs/049-repo-subjects/`
