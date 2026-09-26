# Spec 099 — POST /api/audit/resource-view (client-render audit beacon)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 10 (Hardening — Tier 1 API closures)

## Overview

Closes the loop on the `<PdfViewer>` component shipped in spec 087. That component fires a `sendBeacon`-style `fetch(..., { keepalive: true })` on first paint to confirm the in-browser viewer actually rendered the document. Until this spec, the route it called (`/api/audit/resource-view`) existed only as a UI button pointed at empty air — the request 404'd and the secondary audit signal was silently lost. This spec ships the endpoint as a thin, auth-gated, zod-validated beacon writer that lands a single `resource.view.client_ping` row in `audit_log` and otherwise does nothing.

The endpoint is **secondary telemetry**. The PRIMARY audit row (`resource.pdf.view`) is already written server-side at spec 087's `/repo/resource/[id]/view` page load, before the client even gets the signed-URL token. This route exists so investigators can later distinguish "we rendered the page on the server but the iframe never loaded" (no client ping) from "user actually saw the PDF" (client ping present). Both rows together produce a richer audit trail than either alone.

## Functional Requirements

- **FR-001** — `apps/web/src/app/api/audit/resource-view/route.ts` exists and exports a `POST` handler.
- **FR-002** — `POST` requires `auth()` from `@/auth`. If `session?.user?.id` is falsy, the handler returns `401` with JSON body `{ error: "unauthenticated" }` (the token every API route uses; this spec first said `"unauthorized"`). The audit row is NOT written for anonymous callers (beacons from logged-out tabs are rejected, not silently logged).
- **FR-003** — Request body is read with `readJsonBody` (`@/lib/api-json`): a body that is not JSON, or is empty, returns `400 { error: "invalid_json" }`. It is then validated with `zod`. Accepted shape: `{ resourceId: string (uuid) }`. Legacy alias `{ id: string (uuid) }` is also accepted and normalised to `resourceId`; it is what `PdfViewer` posts. There is **no `viewerId`**: the viewer is always the session's user, which `recordAudit` stores as the row's `user_id`. A client that still sends `viewerId` is not refused (zod drops the unknown key) and the value is never recorded. It used to be written into the row as the viewer, so a forensic record named whoever the client claimed.
- **FR-004** — On validation failure the handler returns `400` with JSON `{ error: "validation_failed", issues: [{ path, message }] }` (`publicIssues`: which field and why, never an echo of the value sent).
- **FR-005** — On success the handler calls `recordAudit({ action: "resource.view.client_ping", entityType: "resource", entityId: <resourceId>, metadata: { beacon: true } })` and returns `204 No Content` with an empty body. The row's `user_id` is the session user.
- **FR-006** — The handler MUST NOT verify that the resource exists. There is no `db.select().from(resources).where(eq(resources.id, resourceId))` lookup. This is fire-and-forget telemetry; we never want a missing/deleted row to break the beacon path.
- **FR-007** — `recordAudit` is imported from `@/lib/audit` (already exported in spec 010). No new audit helper is introduced.
- **FR-008** — A `GET` handler is exported that returns `405 Method Not Allowed` with `Allow: POST` header and JSON body `{ error: "method_not_allowed" }`. This is explicit (Next.js's default 405 page is HTML; probe clients want JSON).
- **FR-009** — Imports follow the repo convention: `import { db } from "@gml/db"` and `import { ... } from "@gml/db/schema"`. (This route doesn't directly touch `db`/`schema` because `recordAudit` does — but the convention is asserted by the governance grep so future refactors stay aligned.)
- **FR-010** — No new dependencies. `zod` is already a dependency of `apps/web` (used by spec 071's `/api/user-prefs` route).
- **FR-011** — Throttled per user (F97): at most 30 beacons per user per 60 s, counted by `rateLimit()` (`@/lib/rate-limit`) before the body is read. Over the limit the handler returns `429 { error: "rate_limited", retryAfterMs }` with a `Retry-After` header (seconds) and writes no row. FR-006 means any well-formed uuid is accepted and every row is permanent (audit_log is append-only), so an unthrottled beacon let a script grow the table for as long as it ran. `PdfViewer` pings once per document it paints, far under the limit.
- **FR-012** — Fails closed: if the limiter cannot count (its query throws), the handler returns `503 { error: "rate_limit_unavailable" }` and writes no row. A dropped ping blocks nothing; `PdfViewer` ignores the response.

## Acceptance Criteria

| Behaviour | Verification |
| --- | --- |
| POST without session | Returns `401 { error: "unauthenticated" }`; no `audit_log` row written |
| POST with session + valid `{ resourceId: <uuid> }` | Returns `204`; one `audit_log` row appears with `action = "resource.view.client_ping"` |
| POST with session + legacy `{ id: <uuid> }` | Returns `204`; row written with the id from `id` (compat path) |
| POST with session + non-uuid string | Returns `400 validation_failed` |
| POST with session + empty body `{}` | Returns `400 validation_failed` (refine rejects missing both keys) |
| POST with session + a body that is not JSON | Returns `400 invalid_json`; no row |
| POST with session + `viewerId` in the body | Returns `204`; the row's `user_id` is the session user and the `viewerId` value appears nowhere in it |
| 31st POST from one user within 60 s | Returns `429 rate_limited` with `Retry-After`; no row |
| POST while the limiter's counter cannot be written | Returns `503 rate_limit_unavailable`; no row |
| POST with `resourceId` that doesn't exist in `resources` | Still returns `204` — no DB lookup, no 404 |
| GET /api/audit/resource-view | Returns `405` with `Allow: POST` header |
| `recordAudit` throws | Beacon still returns `204` — `recordAudit` swallows internally |

## Audit hooks (SM-9)

One free-form action lands in `audit_log.action`:

- `resource.view.client_ping`

Length: 26 chars — well within `varchar(64)`. No migration.

## Out of scope

- Verifying that the user has access to the resource. Beacons are fire-and-forget; the access check already happened server-side at the `/view` page load (spec 087), which is what minted the signed-URL token the iframe is loading.
- Deduplicating pings. Duplicate pings (page refresh, fast-refresh in dev) are accepted as noise, within the FR-011 throttle.
- Returning anything in the 204 body. `sendBeacon` ignores the response anyway; using 204 communicates "received, nothing to read" to any client that does check.
- Touching `PdfViewer.tsx` to align the request body to `{ resourceId }` instead of `{ id }`. The route accepts both shapes via zod so we can keep this Workflow Run UI-clean.

## Design deviations

None. The legacy `{ id }` body alias is a deliberate compatibility surface, called out in the route's JSDoc and the spec.
