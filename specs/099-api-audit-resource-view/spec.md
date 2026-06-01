# Spec 099 — POST /api/audit/resource-view (client-render audit beacon)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 10 (Hardening — Tier 1 API closures)

## Overview

Closes the loop on the `<PdfViewer>` component shipped in spec 087. That component fires a `sendBeacon`-style `fetch(..., { keepalive: true })` on first paint to confirm the in-browser viewer actually rendered the document. Until this spec, the route it called (`/api/audit/resource-view`) existed only as a UI button pointed at empty air — the request 404'd and the secondary audit signal was silently lost. This spec ships the endpoint as a thin, auth-gated, zod-validated beacon writer that lands a single `resource.view.client_ping` row in `audit_log` and otherwise does nothing.

The endpoint is **secondary telemetry**. The PRIMARY audit row (`resource.pdf.view`) is already written server-side at spec 087's `/repo/resource/[id]/view` page load, before the client even gets the signed-URL token. This route exists so investigators can later distinguish "we rendered the page on the server but the iframe never loaded" (no client ping) from "user actually saw the PDF" (client ping present). Both rows together produce a richer audit trail than either alone.

## Functional Requirements

- **FR-001** — `apps/web/src/app/api/audit/resource-view/route.ts` exists and exports a `POST` handler.
- **FR-002** — `POST` requires `auth()` from `@/auth`. If `session?.user?.id` is falsy, the handler returns `401` with JSON body `{ error: "unauthorized" }`. The audit row is NOT written for anonymous callers (beacons from logged-out tabs are rejected, not silently logged).
- **FR-003** — Request body is parsed via `req.json()` (with `.catch(() => ({}))` so a malformed body becomes a 400, not a 500) and validated with `zod`. Accepted shape: `{ resourceId: string (uuid), viewerId?: string (≤128 chars) }`. Legacy alias `{ id: string (uuid) }` is also accepted and normalised to `resourceId` so the existing `PdfViewer` caller (which posts `{ id: resourceId }`) keeps working without a UI edit in this Workflow Run.
- **FR-004** — On validation failure the handler returns `400` with JSON `{ error: "validation_failed", issues: <zod issues> }`.
- **FR-005** — On success the handler calls `recordAudit({ action: "resource.view.client_ping", entityType: "resource", entityId: <resourceId>, metadata: { beacon: true, viewerId: <viewerId | session.user.id> } })` and returns `204 No Content` with an empty body.
- **FR-006** — The handler MUST NOT verify that the resource exists. There is no `db.select().from(resources).where(eq(resources.id, resourceId))` lookup. This is fire-and-forget telemetry; we never want a missing/deleted row to break the beacon path.
- **FR-007** — `recordAudit` is imported from `@/lib/audit` (already exported in spec 010). No new audit helper is introduced.
- **FR-008** — A `GET` handler is exported that returns `405 Method Not Allowed` with `Allow: POST` header and JSON body `{ error: "method_not_allowed" }`. This is explicit (Next.js's default 405 page is HTML; probe clients want JSON).
- **FR-009** — Imports follow the repo convention: `import { db } from "@gml/db"` and `import { ... } from "@gml/db/schema"`. (This route doesn't directly touch `db`/`schema` because `recordAudit` does — but the convention is asserted by the governance grep so future refactors stay aligned.)
- **FR-010** — No new dependencies. `zod` is already a dependency of `apps/web` (used by spec 071's `/api/user-prefs` route).

## Acceptance Criteria

| Behaviour | Verification |
| --- | --- |
| POST without session | Returns `401`; no `audit_log` row written |
| POST with session + valid `{ resourceId: <uuid> }` | Returns `204`; one `audit_log` row appears with `action = "resource.view.client_ping"` |
| POST with session + legacy `{ id: <uuid> }` | Returns `204`; row written with the id from `id` (compat path) |
| POST with session + non-uuid string | Returns `400 validation_failed` |
| POST with session + empty body `{}` | Returns `400 validation_failed` (refine rejects missing both keys) |
| POST with `resourceId` that doesn't exist in `resources` | Still returns `204` — no DB lookup, no 404 |
| GET /api/audit/resource-view | Returns `405` with `Allow: POST` header |
| `recordAudit` throws | Beacon still returns `204` — `recordAudit` swallows internally |

## Audit hooks (SM-9)

One free-form action lands in `audit_log.action`:

- `resource.view.client_ping`

Length: 26 chars — well within `varchar(64)`. No migration.

## Out of scope

- Verifying that the user has access to the resource. Beacons are fire-and-forget; the access check already happened server-side at the `/view` page load (spec 087), which is what minted the signed-URL token the iframe is loading.
- Rate-limiting. A single `keepalive: true` fetch per resource view is bounded by the user clicking through the UI; we accept duplicate pings (page refresh, fast-refresh in dev) as acceptable noise. Server-side dedup is deferred to a Tier-2 pass if/when the audit table grows enough to matter.
- Returning anything in the 204 body. `sendBeacon` ignores the response anyway; using 204 communicates "received, nothing to read" to any client that does check.
- Touching `PdfViewer.tsx` to align the request body to `{ resourceId }` instead of `{ id }`. The route accepts both shapes via zod so we can keep this Workflow Run UI-clean.

## Design deviations

None. The legacy `{ id }` body alias is a deliberate compatibility surface, called out in the route's JSDoc and the spec.
