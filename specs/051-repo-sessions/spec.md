# Spec 051 — Repository: Sessions index + detail

## Context
The Repository is the organizational layer for the LMS: schools, classes,
subjects, sessions, teachers, learners and resources. This spec ports the
sessions index (`/repo/sessions`) and per-session detail (`/repo/session/[id]`)
from `LMS GML Frontend/repository.jsx` (lines 693-824) to live Next.js
server-component routes backed by the `sessions` Drizzle table (`packages/db/src/schema/sessions.ts`).

Sessions are the unit of classroom delivery. Each row joins a school, a class
(grade), a subject, a teacher, and optionally an outline lesson (curriculum
spine) and/or an observation cycle. Status is one of: planned, in_progress,
complete, cancelled (DB CHECK constraint in schema v2).

## Functional requirements
- **FR-051-1** — `/repo/sessions` lists every classroom session, ordered by
  `scheduled_date DESC, scheduled_time DESC`, paged at 200 rows (no skeleton
  pagination — Tier-0 ships table-only).
- **FR-051-2** — Status filter tabs (All / Planned / Today (in_progress) /
  Complete) drive a URL search param `?status=`. Active tab is rendered with
  inverse colours (`var(--ink)` bg, `var(--paper)` ink).
- **FR-051-3** — Subject `<select>` filter drives `?subject=<uuid>`. Populated
  from active `subjects` ordered by `display_order`.
- **FR-051-4** — Counter pills next to each filter tab show row counts for
  that status (across the full result set, not the filtered slice).
- **FR-051-5** — Table columns (exact order from JSX): Date · Time · School
  code · Grade · Subject (coloured chip from `subjects.color`) · Topic ·
  Teacher (English + optional Hindi inline, SM-7) · Status chip · Open link.
- **FR-051-6** — Empty state: full-width "No sessions recorded yet." centered
  in muted ink, padding 24px.
- **FR-051-7** — `/repo/session/[id]` shows two-column layout. Left column:
  "Lesson notes" SectionCard + optional "Linked observation cycle" SectionCard
  (only when `observed=true` and `observation_cycle_id` is set). Right column:
  "Details" SectionCard with KV rows.
- **FR-051-8** — Detail KV rows in spec'd order: Session ID, School, Class,
  Subject, Teacher, Date, Duration, Status, Attendance, Outline (only if
  `outline_lesson_id`), Observed.
- **FR-051-9** — "Observed" chip in the detail header (saffron-soft bg /
  saffron ink) appears alongside the status chip when `observed=true`. Shows
  the observation cycle `code` after a separator dot.
- **FR-051-10** — All cross-record links (school, class, subject, teacher,
  outline) are `RelLink` chips that route to other repo drill-downs:
  `/repo/school/[id]`, `/repo/class/[id]`, `/repo/subject/[id]`,
  `/repo/teacher/[id]`, `/repo/outline/[id]`.
- **FR-051-11** — Access is gated by role: super_admin, programme_admin,
  mentor, observer, teacher. Anyone else (or unauthenticated) is redirected
  to `/forbidden`.
- **FR-051-12** — Hindi name field (`teachers.hindi_name`) is always rendered
  in `var(--deva)` font alongside the English name when present (SM-7).
  Never required.

## Acceptance criteria (JSX components ported)
- `RepoSessionsIndex` (lines 693-746) → `apps/web/src/app/(authenticated)/repo/sessions/page.tsx`
- `RepoSessionPage` (lines 751-824) → `apps/web/src/app/(authenticated)/repo/session/[id]/page.tsx`
- `SectionCard`, `KVRow`, `RelLink` helpers inlined in the detail route
  (matching JSX visual treatment with CSS-variable inline styles)
- `SessionStatus` chip semantics (planned/in_progress/complete) replicated via
  the `STATUS_COLOR` lookup map
- Filter card structure matches JSX `.card` chrome: 10px padding, flex with
  12px gap, `var(--card-hi)` bg, 1px `var(--line)` border, `var(--r-3)` radius
- Table chrome matches JSX `.t` table: header row in `var(--paper-2)`,
  uppercase 10px label-style headers, 1px `var(--line)` row borders

## Audit hooks
None for this spec (read-only views, no PII export). The SM-9 PII-audit
requirement applies to specs 048 (classes) and 054 (learners), not sessions —
session topic + status are aggregated programme data, not learner PII.

## Schema dependencies (no new columns)
- `sessions` (schoolId, classId, subjectId, teacherId, outlineLessonId,
  scheduledDate, scheduledTime, durationMin, topic, status, attendedCount,
  totalCount, observed, observationCycleId)
- `schools` (id, code, name)
- `classes` (id, grade)
- `subjects` (id, name, color, displayOrder, active)
- `teachers` (id, fullName, hindiName)
- `outlineLessons` (id, outlineId, sequence, title, week)
- `courseOutlines` (id, name) — joined for outline link label
- `observationCycles` (id, code) — joined for "Observed · OBS-2026-001" badge
