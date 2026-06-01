# Spec 096 — POST /api/notifications/mark-read

**Status:** complete · **Date:** 2026-06-01 · **Phase:** Workflow Run 4 (API endpoint stubs)

## Overview

Closes the loop opened by spec 070 (`/inbox` notifications feed). The inbox header renders a "Mark all read" button as a native HTML form:

```tsx
<form action="/api/notifications/mark-read" method="post">
  <button type="submit" disabled={unreadCount === 0}>Mark all read</button>
</form>
```

Spec 070 explicitly punted on the endpoint itself ("not implemented in this spec — referenced only as the form's POST target"). Workflow Run 4 implements the endpoint at `apps/web/src/app/api/notifications/mark-read/route.ts`.

Behaviour: flips `notifications.read_at` from NULL → now() for the current user. When the JSON body is empty, mark ALL unread. When the body is `{ids: string[]}`, mark only those rows (still scoped to the caller). Returns `{ok: true, marked: number}` for JSON callers; for form-encoded callers (no `application/json` content-type) returns a 303 redirect back to `/inbox` so the page refreshes with the updated unread count.

## Functional Requirements

- **FR-001** — Route file `apps/web/src/app/api/notifications/mark-read/route.ts` exists. Exports `POST` plus 405 handlers for `GET`, `PUT`, `DELETE`, `PATCH`. Top of file declares `export const dynamic = "force-dynamic"` so Next.js never tries to cache the response.
- **FR-002** — Auth gate: calls `await auth()` from `@/auth`. Returns `401 {error: "unauthenticated"}` when `session?.user?.id` is missing. No role check — any signed-in user can mark their own notifications read.
- **FR-003** — Body parsing tolerates empty / non-JSON bodies (HTML form posts arrive with no JSON payload). When `ids` is present, validates via `z.object({ids: z.array(z.string().uuid()).max(500).optional()})`. Cap of 500 ids guards against pathological payloads.
- **FR-004** — Update scope is ALWAYS `eq(notifications.userId, session.user.id) AND isNull(notifications.readAt)`. When `ids` is provided, ANDs `inArray(notifications.id, ids)`. A client cannot mark another user's notifications read through this surface.
- **FR-005** — UPDATE uses `db.update(notifications).set({readAt: new Date()}).where(...).returning({id: notifications.id})` so the response's `marked` count is the actual row count touched (not a heuristic).
- **FR-006** — SM-1 audit: fires `recordAudit({action: "notifications.mark_read", entityType: "notifications", metadata: {markedCount, scope}})` after the update lands. Best-effort (matches `recordAudit`'s existing contract — a failed audit insert never breaks the user-facing flow).
- **FR-007** — Response shape:
  - JSON caller (`content-type: application/json`): `200 {ok: true, marked: number}`.
  - HTML form caller: `303 Redirect → /inbox` so the browser returns the user to the inbox page with the unread badge cleared.
- **FR-008** — Method matrix: `POST` is the only allowed verb. `GET`, `PUT`, `DELETE`, `PATCH` return `405 {error: "method_not_allowed"}`.

## Acceptance Criteria → behaviour

| Behaviour | Implementation hook |
| --- | --- |
| Unauthenticated request → 401 | `if (!session?.user?.id) return 401` |
| Mark-all with empty body | `where = and(userId, isNull(readAt))` |
| Mark-specific with `{ids: […]}` | `where = and(userId, isNull(readAt), inArray(id, ids))` |
| Cross-user mark blocked | `eq(notifications.userId, session.user.id)` always in WHERE |
| `marked` count is accurate | `.returning({id})` then `updated.length` |
| Form post redirects to /inbox | `if (!content-type.includes("application/json")) 303 → /inbox` |
| GET / PUT / DELETE / PATCH → 405 | dedicated 405 handlers |
| SM-1 audit fires | `void recordAudit({action: "notifications.mark_read", ...})` |

## SM-1 / SM-7 / SM-8 alignment

- **SM-1 (audit on every mutation)**: every successful POST fires `recordAudit` with action `notifications.mark_read` and `metadata.markedCount`. The `audit_log.action` column became varchar(64) in spec 021 — this dotted action lands without an enum migration.
- **SM-7 (no PII leak)**: response carries only `{ok, marked}`. The `notifications` table holds operational events keyed on `user_id`; no learner-name columns are read or echoed.
- **SM-8 (retention ≤ 90 days)**: retention is enforced by `packages/db/src/scripts/retention.ts` (spec 025). This endpoint never inserts rows.

## Out of scope

- Per-row dismiss (delete). The inbox UI mirrors "mark read" only; deletes are a future enhancement.
- Real-time push to other open tabs. The inbox page is `force-dynamic`, so the next page request reflects the new state.
- Mark-unread (toggle back to NULL). Spec 070's button is a one-way "mark all read"; no spec asks for the inverse yet.

## Files

- **CREATED** — `apps/web/src/app/api/notifications/mark-read/route.ts`
- **CREATED** — `specs/096-api-notifications-mark-read/{spec,plan,research,quickstart,tasks}.md`
- **CREATED** — `tests/governance/test_096_api_notifications_mark_read.test.mjs`
- **EDITED** — none (schema locked; UI form already wired in spec 070)
- **MIGRATED** — none (no schema change — `notifications.read_at` already exists from spec 025)
