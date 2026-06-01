# Spec 070 — Inbox notifications feed

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 7 (Core pages)

## Overview

Per-user notifications inbox. Surfaces the rows produced by the `notifications` table (spec 025) as a chronological feed at `/inbox`. The bell-icon button in the desktop topbar (`apps/web/src/components/nav/Topbar.tsx`) and the mobile shell already point conceptually at this route — spec 027 left a placeholder comment ("count badge wired in spec 070 (inbox)") that this spec fulfils. The page is a Next.js server component that uses `auth()` to scope the query to the current user, queries the `notifications` table directly (no API hop), groups rows by date heading, and links each row to its source entity via `entity_type` + `entity_id`. A "Mark all read" button POSTs to `/api/notifications/mark-read` (endpoint scaffolded elsewhere — this spec implements the UI fully, button included). Filter tabs (`All` / `Unread`) toggle via the `?filter=` query string so the page stays server-rendered.

The visual layout is synthesised from the spec brief (no JSX prototype). It mirrors the design language already in use across `/mentorship`, `/videos`, `/observation`: a hairline `header` block, a card cluster, GML CSS-variable tokens for colour, the `--serif` family for the page title, and inline styling. Unread rows are visually weighted (white `--card-hi` background, bold subject); read rows fade to `--paper-2`. Kind icons (📋 / 🎥 / 📅 / ❓) live in a 28×28 rounded chip on the left of each row, mirroring how the dashboard's `TodoRow` keeps icon + content on a single line.

## Functional Requirements

- **FR-001** — Route file `apps/web/src/app/(authenticated)/inbox/page.tsx` exists as a Next.js server component. Top of file: `export const dynamic = "force-dynamic"`. Default export is `async function InboxPage`.
- **FR-002** — Auth: calls `await auth()` from `@/auth` at the top of the component. Redirects to `/login` if `session?.user?.id` is missing. (The `(authenticated)` layout also enforces this — duplicate check matches the dashboard's defensive pattern.)
- **FR-003** — Query: selects from `notifications` WHERE `userId = session.user.id`, ORDER BY `readAt NULLS FIRST, createdAt DESC`, LIMIT 50. Uses Drizzle's `sql\`... NULLS FIRST\`` literal because `drizzle-orm` does not yet expose `asc().nullsFirst()` cleanly across pg-core versions, and unread-first is the documented index ordering (`notifications_user_unread_idx` on `(user_id, read_at, created_at)` — spec 025).
- **FR-004** — Filter tabs `All` / `Unread` rendered as two `<Link>` chips at the top of the list. The Unread tab adds `?filter=unread`; the All tab clears it. The active tab is highlighted with `--indigo-soft` bg + `--indigo` ink. Implementation: read `searchParams.filter`; when `=== "unread"`, narrow the query with `and(eq(notifications.userId, …), isNull(notifications.readAt))`.
- **FR-005** — Date grouping: rows are partitioned into `Today` / `Yesterday` / `This week` / `Older` groups based on `createdAt` and the request-time `now()`. Each group renders only if it has at least one row. Headings use the 10px uppercase tracker pattern (`var(--ink-3)`, `letterSpacing: 0.08em`).
- **FR-006** — Row composition per notification:
  - Left chip: 28×28 rounded chip showing a kind icon. Mapping: `cycle.assigned → 📋`, `video.transcoded → 🎥`, `meeting.scheduled → 📅`, `quiz.due → ❓`. Unknown kinds fall back to `🔔`.
  - Subject: bold weight 600 when `readAt` is null, regular 500 otherwise. Single line, truncated with `text-overflow: ellipsis` on overflow.
  - Body: rendered in `var(--ink-3)` at 12px, two-line clamp via `WebkitLineClamp: 2`.
  - Timestamp: short relative form (`now`, `5m`, `2h`, `Yesterday`, `Mon 14 Apr`) right-aligned in `var(--ink-3)` 11px monospace.
  - Entity link: when `entityType` + `entityId` are both present, the whole row is wrapped in a `<Link>` to the `hrefForEntity()`-derived URL. Mapping: `cycle → /observation/<id>`, `video → /videos/<id>`, `meeting → /mentorship/<id>` (no per-meeting page yet — points at the pairing), `quiz → /quizzes/<id>` (placeholder route — spec 078). When entity is absent, the row renders as a `<div>` with the same visual but no hover affordance.
- **FR-007** — Visual unread vs read affordance: unread row gets `background: var(--card-hi)` + `borderLeft: 3px solid var(--indigo)`. Read row gets `background: var(--paper-2)` + `borderLeft: 3px solid transparent`. Both share the same `border: 1px solid var(--line)` and `borderRadius: var(--r-3)`.
- **FR-008** — "Mark all read" button: rendered as a `<form action="/api/notifications/mark-read" method="post">` button. Disabled (visually muted) when zero unread rows are visible. The endpoint at `/api/notifications/mark-read` is **not** implemented in this spec — it is referenced only as the form's POST target. Hindi name fields (SM-7) do not apply to this page since `notifications` carries no learner-name columns.
- **FR-009** — Empty state: when the filtered query returns zero rows, render a centered "Inbox empty" panel with a muted illustration glyph (📭), the heading "Nothing in your inbox yet.", and a brief explanation linking back to `/dashboard`. Uses `var(--card-hi)` background and `var(--ink-3)` body copy.
- **FR-010** — Header block: page eyebrow ("Notifications"), title ("Inbox") in `var(--serif)`, and a subline showing unread count + total (e.g. `3 unread · 12 total · last 90 days`). Matches the `/mentorship` and `/rtt` header pattern.

## Acceptance Criteria → behaviour

| Behaviour | Implementation hook |
| --- | --- |
| Query is user-scoped | `eq(notifications.userId, session.user.id)` in the where clause |
| Unread surfaces first | `ORDER BY read_at NULLS FIRST, created_at DESC` via `sql\`\``literal |
| Filter ?filter=unread narrows | `and(…, isNull(notifications.readAt))` when active |
| Date headings appear in order | Today → Yesterday → This week → Older, only rendered if non-empty |
| Icon mapping is deterministic | `KIND_ICON: Record<string, string>` lookup with `🔔` fallback |
| Entity link follows the entityType→href map | `hrefForKind()` helper inside the file |
| Mark-all-read button targets the right endpoint | `<form action="/api/notifications/mark-read" method="post">` |
| Tokens come from `globals.css` | Only `var(--…)` colour references; no hex literals |

## SM-7 / SM-8 / SM-9 alignment

- **SM-7 (Hindi names optional)**: not applicable — `notifications` carries `subject`/`body` only. Operators can include Devanagari directly in those fields; the rendered text already inherits font-family fallback through the body's `var(--sans)`.
- **SM-8 (retention ≤ 90 days)**: notifications older than 90 days are deleted by `packages/db/src/scripts/retention.ts` (spec 025). The inbox `LIMIT 50` and the header subline reference "last 90 days" so the user understands the retention horizon.
- **SM-9 (PII audit)**: not triggered — this page does **not** read from `learners`. None of the columns selected here are PII-classified.

## Out of scope

- Implementing the `/api/notifications/mark-read` endpoint (form points at it; the route handler is a separate concern, likely landed alongside the BullMQ worker work).
- Real-time push (notifications appear on next request; no SSE / websocket).
- Per-row dismiss (only mark-all-read is wired; per-row dismiss is a future enhancement).
- Bell-icon unread badge in the topbar — that data plumbing is its own spec (`27` placeholder); this spec only ships the destination page.

## Files

- **CREATED** — `apps/web/src/app/(authenticated)/inbox/page.tsx`
- **CREATED** — `specs/070-inbox-notifications/{spec,plan,research,quickstart,tasks}.md`
- **CREATED** — `tests/governance/test_070_inbox_notifications.test.mjs`
- **EDITED** — none (schema locked; route group + layout already in place)
- **MIGRATED** — none (no schema change)
