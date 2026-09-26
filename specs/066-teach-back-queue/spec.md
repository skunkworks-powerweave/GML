# Spec 066 — Teach-back submissions queue (expert review)

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 7 (Core pages, Tier-0 remainder)

## Overview

Synthesises an expert-review queue at `/rtt/teach-back` that lists every `video_submissions` row
whose `context_type = 'teach_back'`, ordered by submission time descending, alongside a right-hand
preview pane that opens when a row is clicked (driven by the `?id=` searchParam — keeps the page a
server component, no `'use client'` needed). The right pane carries a single "Mark reviewed"
action that POSTs to `/api/teach-back/[id]/review` — the API itself is owned by a later spec; this
page only points the form at the correct URL using `prefetch={false}` semantics on the form.

There is no JSX prototype for this surface — the design is synthesised from the GML design
language (Crimson Pro serif headings, Ladakh-paper palette, inline-style + CSS variables) using
`/mentorship` and `/videos` as the visual reference. No new schema columns are introduced and no
new dependencies are added; the brief's "submitted_at" field is mapped onto the existing
`video_submissions.createdAt` column (see `research.md` for why).

Teach-back queue is the expert-review surface for the RTT "teach-back" assessment loop: a teacher
records themselves teaching a topic, uploads via WhatsApp or direct upload (`video_submissions` is
created with `context_type='teach_back'`), and a subject-expert reviewer marks each submission as
reviewed once they have scored it. The two terminal statuses the brief calls out — `review_pending`
and `reviewed` — are both members of the `video_status` enum (`packages/db/src/schema/enums.ts`
lines 38-39), so no enum migration is required.

## Functional Requirements

- **FR-001**: Route is `apps/web/src/app/(authenticated)/rtt/teach-back/page.tsx`, exported as a
  server component with `export const dynamic = "force-dynamic"`. No `'use client'` directive.
- **FR-002**: `auth()` from `@/auth` runs at the top; absence of `session.user` redirects to
  `/login`. Read-access is permitted for `super_admin`, `programme_admin`, `mentor`, and
  `observer` roles — anything else falls through to `/forbidden`.
- **FR-003**: Query `video_submissions` left-joined to `users` (via `submittedByUserId`) and
  `teachers` (via `teachers.userId = users.id`), filtered to `context_type = 'teach_back'`,
  ordered by `createdAt DESC` (oldest first on the Pending review tab), 80 rows a page with
  "Showing a–b of N" and Previous/Next links. The active tab's predicate is part of the SQL WHERE,
  and the tab counts are aggregates over every teach-back. (It was originally "limit 80, then
  filter in memory", which hid every unreviewed clip older than the 80 newest teach-backs.)
  Returns: submission id, status, createdAt, durationSec, source, teacherName,
  teacherHindi, teacherSubject (`teachers.subjectSpecialism`).
- **FR-004**: Two-column layout — left column (40% width on desktop, full-width when no id is
  selected) shows the list of submissions; right column shows either the preview for the selected
  id or an empty-state hint ("Select a submission on the left to review").
- **FR-005**: Left-column list — each row is a `<Link>` to the same page with `?id=<rowId>` (and
  the current filter preserved); when `?id` matches the row, the row gets a highlighted
  `var(--paper-2)` background and a `var(--ink)` left-border accent.
- **FR-006**: Each list row shows: teacher full name, Hindi name in Devanagari (`var(--deva)`)
  only when present (SM-7 — never render a phantom span when null), subject specialism, the
  submission timestamp formatted in `en-IN` short style, and the status pill.
- **FR-007**: Status pill colour mapping (CSS variables only, no hex), by REVIEW STATE (review is
  `reviewed_at`, not a `status` value, since migration 0022): pending review (ready, unreviewed) →
  `--saffron-soft` / `--saffron`; reviewed → `--lichen-soft` / `--lichen`; anything else (e.g.
  `received`, `queued`, `transcoding`, `failed`) → `--paper-2` / `--ink-3` showing the pipeline
  status in lowercase with underscore replaced by a space.
- **FR-008**: Filter pills at the top — All / Pending review / Reviewed. Active pill = `--ink`
  background with `--paper` text; inactive = transparent with `--ink-2`. Filter is driven by the
  `?status=` searchParam; selecting a filter keeps `?id=` if the row still matches the filter, else
  clears `id`. The selected row is loaded by id, so a deep link opens it on any page.
- **FR-009**: Right-column preview, when a valid id is selected, renders:
  - A SectionCard-style header with teacher name + Hindi (when set) and current status pill.
  - Submission metadata KV grid: Source (chip), Submitted (mono date+time), Duration (mono `Nm Ss`
    or `—`), HLS ready / waiting indicator.
  - Caption raw text (`video_submissions.captionRaw`) when present, in a Ladakh-paper preview box.
  - A "View video" outline button linking to `/videos/[submissionId]` (Tier-0 video player route).
  - A `<form method="POST" action="/api/teach-back/<id>/review">` containing a hidden CSRF-safe
    button labelled "Mark reviewed". The form uses native HTML submission (no client JS) to keep
    the page a server component; the API is implemented in a later spec.
- **FR-010**: When `?id` references a submission that doesn't exist or whose context is not
  `teach_back`, the right column shows the empty state — never throw.
- **FR-011**: SM-7 — Hindi name is rendered conditionally with the `var(--deva)` font; never
  rendered when `null`/empty.
- **FR-012**: SM-9 — This page does not touch the `learners` table and does not surface any
  learner PII; therefore no `recordAudit` hook is required, consistent with the workflow rubric
  shared by `/videos`, `/mentorship`, and the other Run-2 specs.

## Acceptance criteria

| AC | Mapped from brief | Verification |
|---|---|---|
| AC-1 | Page lives at `/rtt/teach-back` | Governance test asserts file existence |
| AC-2 | Server component + `force-dynamic` | Test greps `export const dynamic = "force-dynamic"` and absence of `'use client'` |
| AC-3 | Queries `video_submissions` filtered to `teach_back`, ordered by `createdAt DESC` | Test greps `videoSubmissions`, `"teach_back"`, `desc(` |
| AC-4 | Joins teachers via users | Test greps `teachers` and `users` imports from `@gml/db/schema` |
| AC-5 | Filter pills All / Pending review / Reviewed | Test greps each label literal |
| AC-6 | Status pills `review_pending` + `reviewed` colour-mapped | Test greps `var(--saffron-soft)` and `var(--lichen-soft)` |
| AC-7 | Hindi name conditional, Devanagari font | Test greps `var(--deva)` and the `hindiName ?` ternary marker |
| AC-8 | "Mark reviewed" form POSTs to `/api/teach-back/[id]/review` | Test greps the form action template |
| AC-9 | Right pane "View video" links to `/videos/[id]` | Test greps `/videos/` in the detail block |
| AC-10 | Auth + role gate | Test greps `auth()` call, `redirect("/login")`, and `redirect("/forbidden")` |
| AC-11 | Inline style with CSS variables, no hex | Test asserts no `#[0-9a-fA-F]{6}` and presence of `var(--ink-3)` + `var(--serif)` |

## Schema gaps / deviations

- The brief mentions "ordered by `submitted_at` DESC". The schema's `video_submissions` table has
  no `submitted_at` column — it has `created_at` (notnull, default `now()`) and `verified_at`
  (set when the file finishes transcode). For a teach-back submission these are essentially the
  same instant (the row is inserted at upload time). The page uses `createdAt DESC`. Documented
  in `designDeviations`.

## Out of scope

- The `/api/teach-back/[id]/review` API itself — owned by a later spec, this page only points
  the form at the right URL.
- Per-submission scoring rubric forms — handled by the Phase 8 forms run.
- Real-time updates / SSE — page is `force-dynamic`, server-rendered fresh on every load.
- Bulk-mark-reviewed — not in the brief.

## Audit hooks

None — no PII touched, no `learners` join, consistent with `/videos`, `/mentorship`, and
the rest of Run-2.
