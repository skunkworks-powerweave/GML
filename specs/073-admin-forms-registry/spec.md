# Spec 073 — Admin forms registry editor

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 8 (Forms & quizzes)

## Overview

Ports `LMS GML Frontend/forms.jsx::FormsRegistry` (lines 3-49) into a real CRUD-light admin surface at `/admin/forms`. The JSX prototype's hard-coded `forms` array becomes a `feedback_forms` table query; the "click card → opens form" interaction becomes a Next.js link to `/admin/forms/[id]` which renders a JSON-schema editor on the left and a live read-only preview (placeholder render of the schema's section/item structure) on the right. Save persists via `PUT /api/admin/forms/[id]` which is role-gated to `programme_admin` + `super_admin`, validates that the body parses as JSON, bumps the `version` text column (numeric tail incremented; "1" → "2", "2.3" → "2.4", non-numeric → "<old>+1"), updates the row, and fires `form.schema.update` into `audit_log` via `recordAudit()` — wired SM-1 compliant (audit on every mutation). Schema is locked; no new columns introduced. The detail page is a server component that fetches the row + hydrates a small `'use client'` editor child so JSON editing and the live preview can be reactive.

## Functional Requirements

- **FR-001** — `apps/web/src/app/(authenticated)/admin/forms/page.tsx` is a server component gated by `requireRole(["programme_admin", "super_admin"])`. Lists every row in `feedback_forms` ordered by `kind, audience, version` (descending recency on version). Renders the index as a table with columns: Title (derived `${kind} · ${audience}`), Kind chip (color-coded per JSX: `feedback`/`baseline`/`progress_*`/`final` → indigo; `mentor` audience → rust; etc.), Audience, Version, Active toggle (read-only badge), Last-updated placeholder (since the schema has no `updatedAt` we show version + a derived "—" with deviation note). Each row is a `<Link href="/admin/forms/[id]">` opening the editor.
- **FR-002** — Header label "Forms & Quizzes" + serif H1 "Programme forms" + paragraph copy "Forms are defined as JSON schemas — admins compose them; teachers and mentors fill them." — 1:1 copy with `forms.jsx` lines 16-22. No "New form" button is wired (creating a new form is gated to direct DB seed for v1; flagged in `designDeviations`).
- **FR-003** — `apps/web/src/app/(authenticated)/admin/forms/[id]/page.tsx` is a server component that gates by role, fetches the single `feedback_forms` row by `id`, and renders a 2-column grid (`grid-template-columns: 1fr 1fr`, gap 18). Left column = `'use client'` `<FormSchemaEditor>` (textarea + Save button). Right column = read-only `<FormSchemaPreview>` (renders the same JSON parsed; gracefully shows a "Schema does not parse" panel on invalid JSON). Both are sibling components in `apps/web/src/app/(authenticated)/admin/forms/[id]/parts.tsx`.
- **FR-004** — Save button in the editor `fetch("/api/admin/forms/[id]", { method: "PUT", body: textareaValue, headers: { "Content-Type": "application/json" } })`. On 200, show inline saved-toast ("Saved · v{newVersion}") + refresh server-rendered text via `router.refresh()`. On non-2xx, render server error text inline (rust-colored).
- **FR-005** — `apps/web/src/app/api/admin/forms/[id]/route.ts` exports `PUT(req, { params })`: re-gates role server-side via `requireRole`, reads `req.text()`, attempts `JSON.parse`. If parse fails → 400 `{ error: "invalid_json", message }`. If parse ok → bumps version (`bumpVersion(prev)` helper exported from the same file), updates the row's `schema` + `version` columns, fires `recordAudit({ action: "form.schema.update", entityType: "feedback_forms", entityId: id, metadata: { prevVersion, nextVersion } })`, returns 200 `{ ok: true, version: nextVersion }`.
- **FR-006** — `bumpVersion(prev: string)`: if `prev` matches `^\d+(\.\d+)?$`, increment last numeric component by 1 (e.g. "1" → "2", "1.0" → "1.1", "2.7" → "2.8"). Otherwise return `${prev}+1`. Deterministic, pure, exported for the governance test.
- **FR-007** — Audit hook: every successful PUT writes one row to `audit_log` via `recordAudit`. SM-1 compliance: no UPDATE/DELETE on `audit_log` (existing constraint); the `form.schema.update` action lands as a free-form varchar(64) string per spec 021's enum decision.
- **FR-008** — Hindi name (SM-7): not applicable here. `feedback_forms` has no name/hindiName columns; the title is derived. Devanagari font (`var(--deva)`) is not invoked on this surface.
- **FR-009** — PII (SM-9): not applicable. `feedback_forms` carries no learner PII. Documented in `designDeviations` as a positive confirmation.
- **FR-010** — Styling: inline `style={{ … }}` with CSS variable tokens (`--card-hi`, `--line`, `--ink`, `--ink-3`, `--indigo`, `--saffron`, `--lichen`, `--rust`, `--r-2`, `--r-3`, `--serif`, `--mono`) — consistent with Phase 7 pages (mentorship/page.tsx pattern).

## Acceptance Criteria → JSX components ported

| JSX (forms.jsx::FormsRegistry) | Server counterpart |
| --- | --- |
| Hard-coded `forms = [...]` array | Drizzle `select * from feedback_forms order by kind, audience, version desc` |
| `<button>New form</button>` | Omitted in v1 (deviation) — admins seed via SQL until spec 080 lands a creator. |
| Card grid (3-col) with kind icon + title + responses + due | Server-rendered table (kind chip + audience + version + active + edit-link) — denser layout, but same color palette + serif title style |
| `onClick={() => onOpen(f.id, f.kind)}` | `<Link href="/admin/forms/${id}">` |
| (no editor in JSX prototype) | New: `/admin/forms/[id]` with `'use client'` JSON textarea + live preview + PUT save flow |

## Audit hooks

- `form.schema.update` — written on every successful PUT to `/api/admin/forms/[id]`. Metadata includes `{ prevVersion, nextVersion }`.

## Out of scope

- Creating new forms (deferred — schema seed via SQL/migrations for v1).
- Deleting forms (deferred — admin disables via direct DB edit; `active` toggle UI lands with a future spec).
- Schema validation against a meta-schema (we only check `JSON.parse` succeeds; structural rules are enforced by the runtime FormRunner in spec 074+).
- Version conflict / optimistic concurrency. Last write wins; concurrent edits are rare in this admin context.
- Visual JSON editor (tree-view). v1 ships raw textarea; UX upgrade is a future spec.
