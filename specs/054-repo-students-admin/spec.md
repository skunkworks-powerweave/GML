# Spec 054 — Repo: Learners (admin-only, SM-9 audited)

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-9 (PII audit), SM-7 (Hindi optional).

## Overview

`/repo/students` is the **admin-only** learner index inside the Repository navigation tree. It mirrors the JSX prototype `RepoStudentsIndex` (lines 938–975 of `LMS GML Frontend/repository.jsx`): a saffron-soft PII warning card sits above a single-column table showing **Name · Class · School · Age · Guardian · Attendance%**. The route is gated to `programme_admin` and `super_admin` only (`teacher`/`observer`/`mentor` redirected to `/forbidden`), and **every render writes one `audit_log` row** with `action="learners.bulk_view"`, `entityType="all"`, `metadata.piiAudited=true` plus row count + page offset. Bulk CSV export is a separate, deeper gate: the button is only rendered when `session.user.role === "super_admin"`; it points at `/api/admin/learners/export` (endpoint out-of-scope; just the gated button). Paginates `limit 100 + offset` and accepts an optional `?school=<schoolId>` query param to filter. Learners have **no `hindi_name` column** in the locked schema (see `designDeviations`), so Hindi name rendering is structurally not applicable for this entity — guardian field is plain `varchar(120)` shown as-is.

## FRs

- **FR-001**: `apps/web/src/app/(authenticated)/repo/students/page.tsx` is a Next.js server component, `export const dynamic = "force-dynamic"`.
- **FR-002**: Role gate via `requireRole(["programme_admin", "super_admin"])` at the very top of the component. Lower roles redirect to `/forbidden`.
- **FR-003**: Drizzle query: `db.select({ ... }).from(learners).leftJoin(classes, eq(learners.classId, classes.id)).leftJoin(schools, eq(learners.schoolId, schools.id)).where(<optional school filter + active>).orderBy(schools.code, classes.grade, learners.name).limit(100).offset(offset)`.
- **FR-004**: Visual fidelity to JSX lines 938–975 — page header label "Repository" (uppercase 10px ink-3), `<h1>` "Learners" in serif 28px, saffron-soft PII warning card with lock note, `card`-style table with columns Name | Class | School | Age | Guardian | Attendance%, attendance >90 colored `--lichen` else `--ink-3`, rows clickable to `/repo/class/<classId>`.
- **FR-005**: SM-9 PII audit: call `recordAudit({ action: "learners.bulk_view", entityType: "all", metadata: { piiAudited: true, rowCount, page, schoolFilter? } })` exactly once per render, fire-and-forget. The action string must literally be `learners.bulk_view`.
- **FR-006**: Pagination: read `?page=<n>` (default 1), compute `offset = (page-1) * 100`, render Prev/Next links. Read `?school=<uuid>` and pass to query filter.
- **FR-007**: Bulk export gate: render an "Export CSV" link to `/api/admin/learners/export?school=...` **only** when the resolved session role is `super_admin`; `programme_admin` sees no button.
- **FR-008**: Empty state: "No learners match." with `--ink-3` color when query returns 0 rows.

## Acceptance Criteria → JSX components ported

| JSX component (lines 938–975) | Server-rendered counterpart |
| --- | --- |
| `<div className="page-header">` with label / h1 / subtitle | `<header>` with inline styles (10px uppercase ink-3 label, serif h1, ink-3 13px subtitle) |
| Saffron-soft PII warning `card` with lock icon | `<div>` with `background: var(--saffron-soft)` + lock SVG glyph + warning text |
| `<table className="t">` with thead Name/Class/School/Age/Guardian/Attendance | Native `<table>` with `<thead>` + `<tbody>` and matching column order |
| `window.WIKI.STUDENTS.map(...)` → `wikiLookup.class/school` | Drizzle `leftJoin` on `classes` and `schools` |
| `<tr onClick={() => onNavigate('class/' + cls.id)}>` | `<tr>` wrapped with cursor pointer + Link via `onClick` not feasible in RSC → uses `Link`-wrapped row pattern matching mentorship/page.tsx |
| `attendance > 90 ? lichen : ink-3` | Same threshold |

## Audit hooks

- `recordAudit({ action: "learners.bulk_view", entityType: "all", metadata: { piiAudited: true, rowCount, page, schoolFilter } })` — once per page render, fire-and-forget. Helper already exists at `apps/web/src/lib/audit.ts` (`recordAudit`).
