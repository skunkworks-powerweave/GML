# Spec 047 — Repo schools (index + detail)

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 6 Repository

## Overview

Ports `repository.jsx::RepoSchoolsIndex` (lines 152-221) and `RepoSchoolPage` (lines 226-314) to the production Next.js app under `(authenticated)/repo/`. The prototype draws from `window.LMS.SCHOOLS / window.WIKI.CLASSES / window.WIKI.SESSIONS / window.LMS.TEACHERS` mock globals — the production routes resolve the same shape via Drizzle joins over `schools → zones → districts`, plus `classes`, `sessions`, `teachers`. Visual layout is 1:1 with the prototype (same typography tokens, same card/table structure, same district chip colour scheme: indigo for Leh, saffron for Kargil).

## FRs

- **FR-001** `apps/web/src/app/(authenticated)/repo/schools/page.tsx` — index. Top filter card with district tabs (`all | leh | kgl`) wired via `?district=` searchParam, count badges next to each tab. Table columns: Code (mono), Name, Zone, District (chip), Teachers (#), Classes (#), Sessions (#). Each row links to `/repo/school/[id]`. Uses `auth()` and gates on `super_admin | programme_admin | mentor | observer | teacher`; non-permitted roles `redirect('/forbidden')`. `export const dynamic = "force-dynamic"`.
- **FR-002** `apps/web/src/app/(authenticated)/repo/school/[id]/page.tsx` — detail. Header with code label, serif title, district + zone chips. Two-column body (1.6fr / 1fr grid): left column has Classes table (Grade / Stage chip / Students / Sections / Class teacher) and Recent sessions table (last 12 in DESC scheduled_date order, with school+grade+subject+topic+status); right sidebar has Details KV card (Code, Zone, District, Teachers count, Classes count, Sessions count, Principal name) and Teachers list (avatar initials + name + Hindi name when present + subject specialism). Cross-link to `/repo/school/[id]/learners`. Calls `notFound()` when the id resolves to nothing.
- **FR-003** Hindi names render only when present (SM-7) — applied to teacher Hindi names inside the Teachers sidebar list using `var(--deva)`.
- **FR-004** Governance test `tests/governance/test_047_repo_schools.test.mjs` asserts both route files exist, both query the expected schema tables, and both gate on the allowed-roles set.

## Acceptance criteria → JSX mapping

| Prototype component | Production route | Matched layout pieces |
|---|---|---|
| `RepoSchoolsIndex` header (lines 162-172) | schools/page.tsx | uppercase "Repository" label, serif h1 "Schools", subtitle paragraph |
| District filter card (lines 174-192) | schools/page.tsx | filter pill row, count badges, active state via `var(--ink)` background |
| Schools table (lines 194-217) | schools/page.tsx | code/name/zone/district-chip/teachers/classes/sessions columns, row → detail link |
| `RepoSchoolPage` header (lines 234-249) | school/[id]/page.tsx | back link, code label, serif h1, district+zone chips on the right |
| Classes table card (lines 253-271) | school/[id]/page.tsx | Grade / Stage chip / Students / Sections / Class teacher columns |
| Sessions table card (lines 273-275) | school/[id]/page.tsx | Recent sessions table, status pill |
| Details KV card (lines 279-290) | school/[id]/page.tsx | KVRow grid (120px label / 1fr value), uppercase labels |
| Teachers sidebar list (lines 292-309) | school/[id]/page.tsx | avatar initials + name + Hindi (when set) + subject · phase line |

## Out of scope

- CSV export button is rendered visually for fidelity but is a no-op link to `/repo/schools.csv` — the actual export pipeline is owned by spec 022.
- School-level Hindi name is not in the production schema (`schools` has no `hindi_name` column). The prototype does not render it for schools either, so this is consistent. See `designDeviations` for Principal handling: the prototype hard-codes "Sh. Padma Wangyal"; the production page surfaces `schools.head_teacher_name` (the closest existing column) and falls back to "—" when null.

## Audit hooks (SM-9)

None. Spec 047 is read-only over non-PII organisational records. PII-bearing repo pages (spec 048 class learners list, spec 054 learner detail) carry the audit hooks.
