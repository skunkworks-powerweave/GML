# Spec 065 — RTT online asynchronous hub

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 7 (Core pages)

## Overview

Adds the route `/rtt/online/asynchronous` — a hub of pre-recorded video lectures, Facebook / YouTube / Google Drive embeds, and microlearning resources for teachers to consume between live training sessions. SYNTHESIZED from the spec brief; there is no JSX prototype counterpart to port. Layout is a 3-column responsive card grid; each card represents one external-link resource (from `resources.external_url`) or one `video_submissions` row whose `source` is `external_link` / `google_drive` (or whose `kind=external_link` via the source enum). Top of page is a tab strip of RTT subjects (`rtt_subjects.active = true`) that filters the grid via `?subject=<rtt_subject_id>`.

Cards show:
- A thumbnail placeholder area (16:9 aspect, paper-2 ground) with a centered play glyph since no poster is generated for external embeds.
- Title (resource `name` or video context label).
- Subject chip (the RTT subject name, when filtered or when the video / resource has a per-row tag matching an RTT subject's name — best-effort, see "Schema gaps").
- Duration in minutes (from `video_submissions.duration_sec`, when present) OR a "link" badge for resource-kind cards.
- Card click → opens the external URL in a new tab; for direct external-link videos we fall back to the existing `/videos/[id]` route which already mounts `ExternalEmbed` (spec 044) when `source === 'external_link'`.

This page is read-only. Ingest of new external-link videos is owned by spec 044 (`external-link-embed`) + spec 045 (`upload-progress-ui`).

## Functional Requirements

- **FR-001**: Route `/rtt/online/asynchronous` exists as a server component under `(authenticated)`.
- **FR-002**: `auth()` is called at the top; sessions without `user.id` redirect to `/login`. (Matches the `repo/resources` precedent for defensive auth even though the layout already enforces it.)
- **FR-003**: `export const dynamic = "force-dynamic"` is set — query-string filters preclude static prerender.
- **FR-004**: A top tab strip lists "All" plus every `rttSubjects.active = true` row ordered by name. The current selection is read from `?subject=<id>`. Active pill renders inverted (`--ink` ground, `--paper` ink).
- **FR-005**: The card grid is `repeat(auto-fill, minmax(280px, 1fr))` and pulls TWO content streams:
  - `resources` rows where `externalUrl IS NOT NULL` AND `active = true` AND `kind IN ('Guide','Handbook','Worksheet','Template','Lab-guide','Other')`.
  - `videoSubmissions` rows where `source IN ('external_link','google_drive')`.
  Combined, deduped by id namespace (`r:` vs `v:`), capped at 60 cards, ordered by `createdAt DESC` (resources fall back to `updatedAt`).
- **FR-006**: When `?subject=<id>` is set, the grid filters resources to those whose `tags` JSONB array includes the RTT subject name (best-effort cross-domain match — see "Schema gaps" note). Videos are filtered by their `captionRaw` containing the subject name when present, otherwise included only on "All".
- **FR-007**: Each card click goes to:
  - For a resource → `resources.externalUrl` (target=_blank, rel=noopener).
  - For a video → `/videos/{id}` (the spec 068 detail page, which already handles `ExternalEmbed`).
- **FR-008**: Empty state copy: "No async content yet for this subject." with a discreet hint to programme admins on where to add (`/admin/resources`).
- **FR-009**: Visual tokens mirror `mentorship/page.tsx`: `var(--card-hi)` card ground, `1px solid var(--line)` border, `var(--r-3)` corner, header eyebrow in `var(--ink-3)` uppercase 10px / `0.08em`, page title in `var(--serif)` 28px, subject chip in `var(--paper-2)` ground with mono 11px.
- **FR-010**: SM-7 — No Hindi name surfaces on this page (RTT subjects do not have a Hindi field; teachers do not surface here). N/A.
- **FR-011**: SM-9 — `learners` table is untouched. N/A.

## Acceptance Criteria

| AC | Verification |
|---|---|
| AC-1 | File `apps/web/src/app/(authenticated)/rtt/online/asynchronous/page.tsx` exists. |
| AC-2 | File imports `auth` from `@/auth`, `db` from `@gml/db`, and uses `redirect('/login')` on no session. |
| AC-3 | File contains `export const dynamic = "force-dynamic"` literal. |
| AC-4 | File imports `rttSubjects`, `resources`, `videoSubmissions` from `@gml/db/schema`. |
| AC-5 | File renders a tab strip including an "All" pill and reads `searchParams.subject`. |
| AC-6 | File renders a CSS-grid card section using `repeat(auto-fill, minmax(280px, 1fr))`. |
| AC-7 | File uses `var(--card-hi)`, `var(--line)`, `var(--serif)`, `var(--paper-2)` inline (mirrors mentorship design). |
| AC-8 | File contains the empty-state copy "No async content yet". |

## Schema gaps / deviations

- **No formal RTT-subject ↔ external resource / external video join table.** The schema's `rtt_subjects` is the RTT training programme spine, while `resources` joins to curriculum-side `subjects`, and `video_submissions` has no subject FK at all. For this page we therefore filter resources by string-matching the RTT subject name against the resource's `tags[]` JSONB array (using `sql\`tags @> '...'::jsonb\``), and filter videos by substring-matching against `caption_raw`. Both are best-effort — if cleaner subject-tagging is needed downstream, that's a follow-up spec (and a new join table). Documented here so the seam is visible; no new column added.
- **No `external` thumbnail column.** `video_submissions.poster_key` is for HLS posters only, which never exist for external-link videos. We draw a placeholder play glyph on a `var(--paper-2)` background instead.

## Out of scope

- Live / synchronous session listing (separate spec 064 if needed).
- Tracking watch progress on external embeds (impossible — third-party iframe).
- Admin UI to assign RTT subjects to resources (spec 018 owns resource CRUD; that admin already supports `tags[]` edits).
- Embedding Facebook posts inline — Facebook's oEmbed requires client JS, and the brief explicitly says "Facebook embeds" can be opened in a new tab; the existing `ExternalEmbed` component supports YouTube / Drive / Vimeo for the `/videos/[id]` fallback.

## Audit hooks

None — this is a read-only browse surface on non-PII content. The downstream `/videos/[id]` route already records `video.view` per spec 068.
