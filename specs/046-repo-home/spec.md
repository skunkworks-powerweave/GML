# Spec 046 — Repository home

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 6 (Repository)

## Overview

`/repo` — the organizational entry point. A 5-stat overview (schools / classes / subjects / sessions / resources) plus a "This week's sessions" table and a "Browse" sidebar listing the eight repository entity indexes. 1:1 port of `LMS GML Frontend/repository.jsx` lines 40–134 (the `RepoHome` component). Replaces the prototype's `window.WIKI` / `window.LMS` / `window.wikiLookup` globals with live Drizzle queries against the production schema (`schools`, `classes`, `subjects`, `course_outlines`, `sessions`, `resources`, `teachers`, `mentors`, `learners`). No new schema, no new dependencies.

## FRs

- **FR-001**: Route file `apps/web/src/app/(authenticated)/repo/page.tsx` exists, is a server component, has `export const dynamic = "force-dynamic"`, and imports `db` from `@gml/db` plus the eight relevant tables from `@gml/db/schema`.
- **FR-002**: Page header matches JSX prototype: kicker label `Repository`, `<h1>` `Programme records` in `var(--serif)` at `28px`, descriptive paragraph in `var(--ink-3)` capped at `maxWidth: 640`, plus a "Find a record" button on the right.
- **FR-003**: 5 stat cards (`Stat` equivalent) in a `repeat(5, 1fr)` grid with `gap: 14`. Labels: `Schools`, `Classes`, `Subjects`, `Sessions logged`, `Resources`. Counts come from `db.select({ c: count() }).from(<table>)` (six concurrent calls via `Promise.all`).
- **FR-004**: 2-column body grid (`1.4fr 1fr`, `gap: 18`) containing the sessions table (left) and "Browse" sidebar (right).
- **FR-005**: "This week's sessions" table — header row `Date | Time | School | Grade | Subject | Topic | Status`, body shows up to 8 rows joined from `sessions ← schools ∧ classes ∧ subjects` filtered to `scheduled_date BETWEEN <Mon> AND <Fri>` of the current ISO week (calculated server-side). Each row is a `Link` to `/repo/sessions/[id]` (matches the JSX `onNavigate('session/{id}')`). Status pill uses the `SessionStatus` mapping (`planned | in_progress | complete`).
- **FR-006**: "Browse" sidebar lists 8 entity links in the same order as the JSX prototype: Schools, Subjects, Course outlines, Sessions, Teachers, Mentors, Learners, Reading material. Each row shows an inline icon glyph, the label, a mono-font count and a chevron — top border separator between rows except the first.
- **FR-007**: All inline styles use CSS variables (`var(--ink)`, `var(--paper-2)`, `var(--line)`, `var(--r-3)`, `var(--serif)`, `var(--mono)`, etc.) matching the design tokens in `apps/web/src/app/globals.css`. No hard-coded hex colors or font-family strings.
- **FR-008**: Governance test at `tests/governance/test_046_repo_home.test.mjs` asserts route exists, contains `import { count }` and all 8 schema table imports, computes the week range, links to subroutes, and renders all 5 stat labels.

## Acceptance criteria

- AC-1 (visual fidelity): Side-by-side check of `RepoHome` JSX vs. `/repo` route shows identical typography (Crimson Pro 28px h1, Inter Tight body), identical spacing (14px stat gap, 18px column gap), identical color tokens.
- AC-2 (data correctness): Each stat number equals `SELECT count(*) FROM <table>`. Empty tables show `0`, not a placeholder.
- AC-3 (week filter): "This week" range is calculated server-side from `new Date()` and renders Mon–Fri date range in the section subhead (`Mon DD MMM → Fri DD MMM YYYY`).
- AC-4 (no PII surface): Spec 046 does not display learner names anywhere — only counts. No `recordAudit({entity: "learner"})` call is required for the home page.
- AC-5 (governance test green): `pnpm test -- tests/governance/test_046_repo_home.test.mjs` passes.

## Out of scope

- The Browse sidebar links point to `/repo/{schools,subjects,outlines,sessions,teachers,mentors,learners,resources}` — those routes ship in sibling specs (047 schools, 048 classes/learners, 049 subjects, 050 outlines, 051 sessions, 052 teachers, 053 mentors, 054 learners, 055 resources). 404s until those land — this spec only renders the index.
- "Find a record" button is rendered for visual parity but has no `onClick` handler in v1 (search ships later).
- No mobile responsive rework — the existing `(authenticated)/layout.tsx` already swaps to `MobileShell`.
