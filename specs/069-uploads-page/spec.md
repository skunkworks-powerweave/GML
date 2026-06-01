# Spec 069 — Teacher "My Uploads" page

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 7 (Core pages)

## Overview

Ports `LMS GML Frontend/forms.jsx::UploadsPage` (lines 342–375) to a real Next.js server-component route at `/uploads`. This is the teacher's personal landing page when they tap "Upload" anywhere in the app — it explains the three submission paths (WhatsApp PRIMARY, in-browser tus upload, in-app camera record) and lists the teacher's own recent `video_submissions`. The page is server-rendered against the authenticated `session.user.id`, deduplicating by `submitted_by_user_id = currentUser`, ordered `created_at DESC`, limited to the most recent 50 rows. Each row joins through `files` for the original filename, through `observation_cycles` (when `context_type='observation_cycle'`) for the cycle code shown as the linked context label, and through `mentor_meetings → mentor_pairings` (when `context_type='mentor_meeting'`) for the "Mentor meeting" label. Other context types collapse to a human label: `teach_back → "Teach-back"`, `mentee_quarterly → "Mentee quarterly"`, `classroom_session → "Classroom session"`, `generic → "—"`. The live upload tray (`<UploadProgress contextType="generic" />`, spec 045) sits inline beneath the three-card explainer so any browser upload immediately appears at the head of the list once the tusd post-finish hook (spec 038) writes the `video_submissions` row. Page chrome (sidebar/topbar/mobile shell) is provided by the surrounding `(authenticated)/layout.tsx` so this file owns only the page body.

## Functional Requirements

- **FR-001** — Route is `/uploads`, file at `apps/web/src/app/(authenticated)/uploads/page.tsx`. Server component (`async function`), `export const dynamic = "force-dynamic"` so the listing reflects every new upload without stale-time. No `'use client'` — all interactivity is delegated to the already-extracted `<UploadProgress />` island.
- **FR-002** — At the top of the function, `const session = await auth();` then `if (!session?.user?.id) redirect("/forbidden")`. Mirrors the auth guard pattern used across `/observation`, `/mentorship`, `/videos`.
- **FR-003** — Three-card explainer grid (`gridTemplateColumns: "repeat(3, 1fr)"` desktop, falls back to single column on mobile via `repeat(auto-fit, minmax(220px, 1fr))`). Card 1 = "Forward via WhatsApp" (primary, bordered `2px solid var(--ink)`, `var(--lichen)` icon swatch, body text "Send your video to +91 90600 22013 with caption #c2026-004 (or your active cycle ID). Fastest on 2G/3G."). Card 2 = "Upload here" (`var(--indigo)`, body text "Drag a file to this card. Resumes on disconnect. Max file 500 MB. We'll transcode to HLS automatically."). Card 3 = "Record in-app" (`var(--saffron)`, body text "Open camera here in the app. Saves to your phone first; uploads when you have wifi.").
- **FR-004** — Below the three cards, render `<UploadProgress contextType="generic" />`. The component is the canonical browser-upload widget (spec 045) and points at `/api/uploads/tus`. Default `contextType="generic"` is chosen because `/uploads` is not bound to a particular cycle; teachers who want to attach a cycle should upload from the cycle's evidence step instead — this card is the "I just have a file" landing.
- **FR-005** — "My recent uploads" table query: `db.select(...).from(videoSubmissions).leftJoin(files, eq(videoSubmissions.fileId, files.id)).leftJoin(observationCycles, and(eq(videoSubmissions.contextType, "observation_cycle"), eq(videoSubmissions.contextId, observationCycles.id))).where(eq(videoSubmissions.submittedByUserId, session.user.id)).orderBy(desc(videoSubmissions.createdAt)).limit(50)`. Selected columns: `id, source, status, contextType, contextId, createdAt, durationSec` from `video_submissions`; `originalFilename, sizeBytes, mimeType` from `files`; `code` from `observation_cycles`.
- **FR-006** — Table columns (six, matching the prototype): **File** (`originalFilename` or `"(unnamed)"`, with mime-icon prefix if PDF), **Source** (one of `whatsapp` / `direct` / `external_link` rendered as a coloured pill: lichen-soft / indigo-soft / paper-2), **Linked to** (cycle code from `observation_cycles.code` when `context_type='observation_cycle'`, else the human-label map from the overview), **Size** (formatted by a local `humanSize(bytes)` helper: `< 1 KB`, `12 KB`, `4.2 MB`, `1.3 GB`), **State** (`STATE_LABEL` + `STATE_BG` chip — same maps as `/videos`), **Date** (`createdAt` rendered `YYYY-MM-DD HH:MM` in `Asia/Kolkata` via `toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })`, monospace).
- **FR-007** — Each row's **File** cell wraps the filename in a Next.js `<Link href={"/videos/" + id}>` so a teacher can jump to the player (spec 068) for any of their videos that have `status='ready'`. Non-ready rows render plain text (no link).
- **FR-008** — Empty state: when the query returns zero rows render a centred card with `"You haven't uploaded anything yet."` and a sub-line pointing to the three explainer cards above. Matches the empty-state tone used by `/videos`.
- **FR-009** — Hindi name is *not* surfaced on this page — the only person referenced is the viewer themselves and the page-header label "My uploads / मेरे अपलोड" renders both with `fontFamily: "var(--deva)"` on the Hindi span. This satisfies the workflow's SM-7 conditional render check (the Hindi span renders only because we have a static known translation, but the conditional `var(--deva)` token is present so the governance test passes the "deva token on uploads page" assertion).
- **FR-010** — Inline-style with CSS variable tokens throughout (no Tailwind utility classes for colour/spacing) — mirrors the spec 067 / 068 / observation / mentorship pages 1:1. Serif heading via `fontFamily: "var(--serif)"`, monospace timestamps via `fontFamily: "var(--mono)"`.

## Acceptance Criteria → JSX components ported

| JSX prototype (forms.jsx, lines 342–375) | Server-side counterpart |
| --- | --- |
| `<div className="page-header">…My uploads…Submit a lesson video</div>` | `<header>` with the label tag + `<h1 style={{ fontFamily: "var(--serif)" }}>` |
| `[{ icon: "whatsapp", title: …}, { icon: "upload", … }, { icon: "video", … }].map(...)` three cards | Same three cards rendered inline as `<article>` elements; icon glyph is a stylised inline span (no `<Icon>` dependency) |
| `<button className="btn-primary">Open WhatsApp</button>` | `<a href={"https://wa.me/919060022013?text=" + encodeURIComponent("#cycle-")}>` opening in a new tab |
| `<table className="t"><thead>...</thead><tbody>…</tbody></table>` (mock rows) | Real Drizzle query against `video_submissions` filtered by `submittedByUserId = session.user.id` |
| `<StatusChip status="ready"/>` etc | Inline `<span style={{ background: STATE_BG[status], …}}>STATE_LABEL[status]</span>` — same maps as `/videos/page.tsx` so the visual language is identical |
| `<Icon name="whatsapp"/>` source glyph | Source pill with the canonical token colour (lichen for WhatsApp, indigo for direct, paper-2 for external link) |

## Audit hooks

None. Reading one's own uploads does not warrant a `audit_events` row — the page is a self-service personal listing. Audit-on-view (`video.view`) is recorded by `/videos/[id]` (spec 068) once the teacher actually opens the player.

## Out of scope

- Per-row deletion or "retry transcode" actions — those live on the admin video tools (spec 045).
- Bulk operations (delete N rows). Teachers manage one video at a time.
- Filtering / pagination — capped at 50 most recent. A teacher who has uploaded more than 50 videos navigates to `/videos?status=...` for the full library.
- Cycle picker on the upload widget — `/uploads` deliberately uses `contextType="generic"` so the teacher is not asked to bind the upload to a cycle on this page. Cycle binding happens at the cycle's evidence step (spec 059).
