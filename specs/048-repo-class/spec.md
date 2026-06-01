# Spec 048 — Repository: Class detail + PII-gated learners list (SM-9)

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-7 (Hindi optional), SM-9 (PII access audit-logged for learners roster).

## Overview

Port the JSX prototype's `RepoClassPage` (LMS GML Frontend/repository.jsx lines 361-439) into two real Next.js routes:

1. `/repo/class/[id]` — class detail page: KV details sidebar (school, grade, stage, students count, sections count, class-teacher name), subjects taught at this grade with stats, and recent classroom sessions for the class. No PII shown.
2. `/repo/class/[id]/learners` — full learner roster (the PII-gated sub-route). Reads `learners` for the class and shows name + attendance%. Only `super_admin` and `programme_admin` may view. Every server-side read writes an `audit_log` row via `recordAudit({action: "learners.view", entityType: "class", entityId: params.id, metadata: {...}})` — that is the SM-9 enforcement hook, mirroring `/admin/data/learners`.

Both routes are server components, hit Drizzle directly against tables locked in spec 015 (classes), 019 (learners), 014 (subjects), 017 (sessions / classroomSessions), and the geography spine (schools, teachers). They mirror `/mentorship/[pairingId]/page.tsx` (Tier-0) for shell/typography/spacing: serif H1, ink-3 muted captions, `var(--card-hi)` cards, `var(--line)` borders, `var(--r-3)` radius, KV rows on borderTop hairlines, Hindi rendered with `var(--deva)` and only when present.

## Functional Requirements

- **FR-001**: `apps/web/src/app/(authenticated)/repo/class/[id]/page.tsx` exists as a server component with `export const dynamic = "force-dynamic"`. Queries: SELECT class → JOIN schools → list subjects whose `gradesMin..gradesMax` covers the class's grade → list recent classroom sessions for the class (LEFT JOIN subjects, teachers). Renders header (Back to school, label "Class · {school.code}", H1 "Grade N"), 2-column grid (1.6fr Subjects + Sessions | 1fr Details KV).
- **FR-002**: `apps/web/src/app/(authenticated)/repo/class/[id]/learners/page.tsx` exists as a server component with `export const dynamic = "force-dynamic"`. Calls `requireRole(["super_admin", "programme_admin"])` first; non-matching roles redirect to `/forbidden`. After the role check passes AND BEFORE the DB read, calls `recordAudit({ action: "learners.view", entityType: "class", entityId: id, metadata: { route: "/repo/class/[id]/learners" } })`. Then SELECTs `learners WHERE classId = id AND deletedAt IS NULL` and renders the roster table (name, age, guardian, attendance%).
- **FR-003**: Stage chip color: Primary → lichen, Middle → indigo, High → saffron (`var(--lichen-soft)` / `var(--indigo-soft)` / `var(--saffron-soft)` bg with matching ink).
- **FR-004**: Class teacher name renders from `classes.class_teacher_name` (already in schema — varchar(160) NULL). No FK to teachers (intentional — spec 015 keeps it freeform).
- **FR-005**: Notation: subjects table shows "Grades covered N–M" using `subjects.gradesMin` and `subjects.gradesMax`. Filter via SQL `WHERE (gradesMin IS NULL OR gradesMin <= class.grade) AND (gradesMax IS NULL OR gradesMax >= class.grade) AND active = true`.
- **FR-006**: Sessions list shows last 12 rows ORDER BY scheduledDate DESC; columns date, time, subject, topic, teacher (with optional Hindi name in `var(--deva)`), status pill (planned/in_progress/complete/cancelled with lichen/saffron/indigo/rust mapping).
- **FR-007**: Hindi names (SM-7) — `teachers.hindiName` is rendered only when truthy (conditional `? : null`), inline-after the English name with 8px margin-left.
- **FR-008**: Class detail page links to the learners sub-route via `<Link href={`/repo/class/${id}/learners`}>` with a 'View roster (PII)' tile in the right column — but only renders that link if the current session user's role is `super_admin` or `programme_admin`.
- **FR-009**: Governance test (`tests/governance/test_048_repo_class.test.mjs`) asserts (a) both route files exist, (b) detail route imports `db`, `classes`, `schools`, `subjects`, `sessions`, `teachers` from `@gml/db/schema` and uses `eq`/`desc` from `drizzle-orm`, (c) learners route imports `learners`, calls `requireRole(["super_admin", "programme_admin"])`, and calls `recordAudit` with `action: "learners.view"`.

## Acceptance criteria → JSX components ported

| JSX prototype element | Ported to |
| --- | --- |
| `RepoClassPage` page header (label, H1, sub) | `/repo/class/[id]/page.tsx` header |
| `RepoClassPage` 2-column body grid | `/repo/class/[id]/page.tsx` `<section style={{display:"grid", gridTemplateColumns:"1.6fr 1fr"}}>` |
| `SectionCard "Subjects (n)"` | inline `<article>` card with serif h2 |
| `SectionCard "Sessions held (n)"` | inline `<article>` card listing classroom sessions |
| `SectionCard "Details"` KV rows | inline KV rows with grid 120px 1fr + borderTop var(--line) |
| `SectionCard "Learners (sample)"` (PII-restricted) | promoted to its own route `/learners`, gated by SM-9 |
| Hindi name rendering pattern from `/mentorship/[pairingId]` | same `var(--deva)` style on teacher rows |

## Audit hooks (SM-9)

- `recordAudit({action: "learners.view", entityType: "class", entityId: params.id, metadata: {route: "/repo/class/[id]/learners", rowCount}})` fires on every successful render of the learners sub-route.
- The audit row is best-effort (try/catch swallowed in `lib/audit.ts`); page render never fails because audit write failed.

## Out of scope

- Editing class details (admin grid covers that)
- Editing learners (admin grid covers that, also SM-9 audited)
- Linking individual learners to user accounts (no learner-as-user model)
- Pagination on learners (left as TODO in tasks once classes >50 are common; for v1 we cap at 80)
