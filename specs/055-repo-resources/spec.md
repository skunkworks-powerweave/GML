# Spec 055 — Repository reading-material index + detail

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 6 (Repository)

## Overview

Ports `repository.jsx` lines 977-1063 (`RepoResourcesIndex` + `RepoResourcePage`) into two Next.js server-component routes. The prototype reads `window.WIKI.RESOURCES` and `window.wikiLookup.subject(id)`; the routes replace those with Drizzle queries against the locked production schema (`resources`, `resource_subjects`, `subjects`). No new schema columns, no new dependencies. Layout, typography (Crimson Pro for titles, JetBrains Mono for IDs / dates, Inter Tight elsewhere) and the warm Ladakh-paper colour tokens (`--paper`, `--ink`, `--line`, `--saffron`, …) are mirrored from `apps/web/src/app/(authenticated)/mentorship/page.tsx` and the sister `repo/subjects/page.tsx`.

The index is a table of every active resource with optional filter by `kind` (Policy | Guide | Handbook | Worksheet | Template | Routine | Calendar | Checklist | Lab-guide | Rubric | Other) via `?kind=` searchParam. Detail page shows a KV sidebar (Kind / Owner / Pages / Updated / Subjects → linked to `/repo/subject/[id]` / Tags) plus an "About this document" main panel. When `file_key` is set, a "Download PDF" button appears (placeholder href to the spec-087 viewer route — that's the only deviation from the prototype's "Download PDF" button label); when `external_url` is set, "Open external link" is shown.

PDF inline preview is intentionally OUT OF SCOPE for this spec — spec 087 (`pdf-viewer-watermark`) owns the actual canvas viewer. This page only links to it.

## Functional Requirements

- **FR-001**: Route `/repo/resources` lists every `resources.active = true` row, ordered by `updated_at DESC`, joined to `resource_subjects` + `subjects` (subject names eager-loaded for the table chips).
- **FR-002**: Index columns: Title (bold) · Kind (chip) · Subjects (first 2 names + `+N` overflow chip) · Owner · Pages · Updated (mono date) · chevron. Rows click through to `/repo/resource/[id]`.
- **FR-003**: Index filter strip — All / Policy / Guide / Handbook / Worksheet / Template / Routine / Calendar / Checklist / Lab-guide pills using `?kind=` searchParam. Active pill = `--ink` ground with `--paper` ink; inactive = transparent w/ `--ink-2`.
- **FR-004**: Route `/repo/resource/[id]` server-fetches the resource + its joined subjects. 404 via `notFound()` if id unknown or `active=false`.
- **FR-005**: Detail KV sidebar in a SectionCard: Kind (chip), Owner, Pages, Updated (mono), Subjects (clickable RelLinks → `/repo/subject/[id]`), Tags (chips from `resources.tags` JSONB array).
- **FR-006**: Detail page shows a "Download PDF" primary button when `file_key` is non-null (links to `/repo/resource/[id]/view` — spec 087's route, may 404 today but the link itself is correct), or an "Open external link" outline button when `external_url` is non-null. At least one source is guaranteed by the schema's `resources_has_source_check` CHECK constraint.
- **FR-007**: Auth: `auth()` at top; redirect to `/login` if no session. Layout already enforces this but pages still check defensively, matching `repo/subjects` precedent.
- **FR-008**: SM-7 — Hindi name field is not relevant here (resources have no Hindi field). N/A.
- **FR-009**: SM-9 — Resources are non-PII. No audit hook required (per the workflow rubric, only specs 048 and 054 need `recordAudit`).

## Acceptance Criteria

| AC | Mapped from JSX | Verification |
|---|---|---|
| AC-1 | `RepoResourcesIndex` table headers Title/Kind/Subjects/Owner/Pages/Updated (lines 987) | Governance test greps `<th>Title</th>` etc. |
| AC-2 | Kind chip rendered via inline pill on each row | Governance test asserts `Policy` filter pill present |
| AC-3 | Subjects join (resource_subjects ↔ subjects) | Governance test asserts `resourceSubjects` + `subjects` imports |
| AC-4 | Detail KV grid for Kind/Owner/Pages/Updated/Subjects/Tags | Governance test asserts each KV label string present |
| AC-5 | `notFound()` on unknown id | Governance test greps `notFound()` |
| AC-6 | CSS-variable tokens used inline, no Tailwind colour classes | Governance test greps `var(--ink-3)` and `var(--serif)` |
| AC-7 | `export const dynamic = "force-dynamic"` | Governance test greps the literal |
| AC-8 | Drizzle imports from `@gml/db` + `@gml/db/schema` | Governance test asserts both imports |

## Schema gaps / deviations

- None. The `resources` table already has every column the JSX prototype reads (`name`, `kind`, `owner`, `pages`, `tags`, `updatedAt`, `fileKey`, `externalUrl`). `resource_subjects` provides the many-to-many.

## Out of scope

- PDF canvas viewer (spec 087).
- Resource search box (not in JSX prototype for the index).
- Resource creation / edit (admin registry already owns it — spec 018).

## Audit hooks

None — non-PII content, per workflow contract for spec 055.
