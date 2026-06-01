# Spec 053 — repo/mentors (Repository · Mentors)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 6 Repository (specs 046-056)

## Overview

Ports the `RepoMentorsIndex` JSX prototype (`LMS GML Frontend/repository.jsx` lines 910-936) to a Next.js
route at `/repo/mentors`, then synthesises a mentor-detail page at `/repo/mentor/[id]` that mirrors the
teacher-detail pattern (KV header + pairings grouped by status, with current-quarter chip and cached
`meetings_count`).

The JSX uses `window.LMS.MENTORS` mock data. Production swaps that for direct Drizzle queries against
the production schema (`mentors`, `mentor_pairings`, `teachers`). No new columns, no new dependencies.
Hindi names render only when present (SM-7). No PII is shown beyond what teacher/mentorship pages
already expose, so no SM-9 audit hook is required for this spec.

## Functional Requirements

- **FR-001**: `apps/web/src/app/(authenticated)/repo/mentors/page.tsx` renders the index — a table with
  columns: Name, नाम (Hindi name), Expertise (joined `expertise_areas`), Based in (Leh/Kargil chip),
  Mentees (count of active pairings). Sorted alphabetically by `mentors.name`.
- **FR-002**: Mentee counts come from a single `groupBy` over `mentor_pairings` filtered to
  `status = "active"`, joined back to the mentor row by id. No per-row N+1.
- **FR-003**: Only `active = true` mentors are listed. Inactive mentors remain in the DB for history.
- **FR-004**: `apps/web/src/app/(authenticated)/repo/mentor/[id]/page.tsx` renders the detail —
  KV header (Name, Hindi name when set, Based-in chip, Expertise, Bio when set) plus pairings list
  grouped by status (`active` → `review` → `paused` → `complete` → `ended`), each card showing
  teacher name + Hindi (when set), Q-quarter chip, `meetings_count`, and `last_meeting_at`.
- **FR-005**: Each detail-page pairing card links to `/mentorship/[id]` (the Tier-0 mentorship detail).
- **FR-006**: Each index row links to `/repo/mentor/[id]`.
- **FR-007**: Both pages are server components with `export const dynamic = "force-dynamic"` and run
  `auth()` at the top, redirecting to `/login` when there is no session. Role gating happens at the
  shell layout (any authenticated user can read the repo; per-row PII gating lives in spec 048 / 054
  for teachers / learners).
- **FR-008**: Visual fidelity — Crimson Pro serif h1 at 28px, Noto Devanagari for Hindi names,
  CSS-variable palette (`--ink`, `--paper`, `--card-hi`, `--line`, `--indigo`, `--saffron`,
  `--lichen`, `--rust`, `--r-2`, `--r-3`), inline `style={}` to match Tier-0 mentorship page idiom.
- **FR-009**: Status pills use the same colour mapping as `/mentorship` (`active`→lichen,
  `review`→saffron, `paused`/`ended`→paper-2, `complete`→indigo) for cross-page consistency.

## Acceptance criteria

- AC-1: Visiting `/repo/mentors` lists every active mentor with the five columns from the JSX
  prototype, with the Hindi-name column rendered in Devanagari font and falling back to empty
  string when `hindiName` is NULL.
- AC-2: Base-location renders as a coloured chip: indigo for `Leh`, saffron for `Kargil`, neutral
  for anything else, exactly matching the JSX `Chip` component's kind-switch.
- AC-3: Mentees column shows `count(*)` of `mentor_pairings` for that mentor with `status="active"`.
- AC-4: Clicking a mentor row lands on `/repo/mentor/<id>` which renders the synthesised detail.
- AC-5: Detail page groups pairings by status under labelled headers, hides empty groups, and
  links each card to `/mentorship/<pairingId>`.
- AC-6: Hindi names appear only when set — `hindiName` NULL never produces a phantom Devanagari span.
- AC-7: Governance test `tests/governance/test_053_repo_mentors.test.mjs` passes —
  asserts both route files exist, both query `mentors` / `mentorPairings`, both render the
  Devanagari font token, the detail groups by all five status values.

## Out of scope

- Per-row PII gating (spec 048 / 054 handle teacher and learner PII with SM-9 audit hooks).
- Mentor create / edit forms (admin registry handles CRUD via spec 012).
- Pairing creation flow (lands in spec 056 Feedback-lifecycle).
