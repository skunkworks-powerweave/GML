# Spec 097 — POST /api/teach-back/[id]/review (mark teach-back reviewed)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** Workflow Run 4 (API endpoint closure)

## Overview

Implements the API endpoint that spec 066 (teach-back queue) pointed its "Mark reviewed" button at but never owned. The route is a single Next.js App-Router file at `apps/web/src/app/api/teach-back/[id]/review/route.ts` exporting `POST` (the happy path) and `GET` (returns 405 so the route doesn't silently swallow misrouted GETs from a mistyped link or a browser address-bar refresh).

The caller is a native HTML `<form method="POST" action="/api/teach-back/{id}/review">` rendered inside the right-hand preview pane of `/rtt/teach-back` (server component, no client JS, no CSRF token wired). Submission flips the matching `video_submissions` row from `status='review_pending'` (or any non-reviewed status) to `status='reviewed'` and records a `teach_back.reviewed` audit row keyed on the submission uuid + the reviewer's user id. This closes the expert-review loop in RTT Phase 7.

There is no UI deliverable in this spec — spec 066 already shipped the form and its submit button. We are only filling in the API that the button was already pointing at. The page assumes a full-page POST→200 navigation: after the API responds the browser performs a standard form-post navigation back to the queue and the row re-renders with the "Already reviewed" affordance (because spec 066's preview pane checks `selected.status === "reviewed"` and replaces the button with a lichen-soft pill).

The endpoint is auth-gated by `auth()` from `@/auth` (NextAuth session) and role-gated to the same four roles spec 066 already gates read access to: `super_admin`, `programme_admin`, `mentor`, `observer`. The role list is *identical* to spec 066's `READ_ROLES` set — anyone who can see a teach-back row in the queue can mark it reviewed; a teacher reviewing their own video is explicitly disallowed (teachers never appear in the queue, so they never have a button to click, and even if they POSTed manually they'd be blocked at 403). Path param `id` is the uuid of the `video_submissions` row.

The route uses `.returning({id})` on the `UPDATE` to detect "no row updated" in a single round-trip — either the id doesn't exist, or it exists but `context_type != 'teach_back'`. Both collapse to 404 from the caller's perspective, which is correct: the queue never exposes ids that aren't teach-backs, so a 404 here is always either a stale link or a manual probe.

Audit hook (SM-1): `recordAudit({action: "teach_back.reviewed", entityType: "video_submission", entityId: id})`. The userId is grabbed from the session by `recordAudit` itself (it calls `auth()` internally) — we don't need to thread it through. The audit fires *after* the UPDATE succeeds, never before, so a 404 path leaves no audit footprint. We deliberately do not echo any joined identity columns (teacher name, Hindi name, subject) in the response — the success body is exactly `{ok: true}` so an exfiltration via repeated POSTs reveals nothing beyond the existence of the id (which spec 066 already gates by role).

## Functional Requirements

- **FR-001** — Route file lives at `apps/web/src/app/api/teach-back/[id]/review/route.ts`, declares `export const dynamic = "force-dynamic"` (this is a mutation, never cacheable).
- **FR-002** — Exports an async `POST(req, ctx)` handler where `ctx.params` is `Promise<{ id: string }>` (App-Router Next 15 contract — params is a Promise).
- **FR-003** — Exports an async `GET()` handler that returns `NextResponse.json({error: "method_not_allowed"}, {status: 405})`. We don't bother with PUT/DELETE/PATCH stubs — Next's default 405 fallback covers those, but an explicit GET stub is load-bearing because a browser address-bar refresh after a successful POST might re-fetch the URL via GET and we want the response to be a clean 405 rather than a confusing 200/HTML page from the App Router's HTML fallback.
- **FR-004** — Auth gate: `const session = await auth()`. If `!session?.user?.id`, return 401 `{error: "unauthenticated"}`. No redirect — this is an API route, not a page.
- **FR-005** — Role gate: `hasAnyRole(session.user.role, ["super_admin", "programme_admin", "mentor", "observer"])`. Failure returns 403 `{error: "forbidden"}`. The role list is duplicated in `ALLOWED_ROLES` as a typed `as const` tuple for IDE intellisense; the test asserts the exact four role strings appear in the source.
- **FR-006** — Path param: `const { id } = await ctx.params`. If `!id || typeof id !== "string"`, return 400 `{error: "invalid_id"}`. (Next's type system guarantees `id` is a string when routed correctly, but the runtime check is cheap insurance against a future framework-version drift.)
- **FR-007** — Side effect: a single SQL `UPDATE video_submissions SET status='reviewed' WHERE id = $1 AND context_type = 'teach_back'`. Implemented with drizzle's `db.update(...).set({status: "reviewed"}).where(and(eq(videoSubmissions.id, id), eq(videoSubmissions.contextType, "teach_back"))).returning({id: videoSubmissions.id})`. The `.returning({id})` is required so we can detect zero-row updates in a single round-trip.
- **FR-008** — If `updated.length === 0`, return 404 `{error: "not_found"}`. Do NOT audit. This collapses two failure modes (unknown id, wrong context type) into the same response — both look the same from the queue's perspective.
- **FR-009** — Audit hook (SM-1): on a successful UPDATE, call `void recordAudit({action: "teach_back.reviewed", entityType: "video_submission", entityId: id})`. The `void` is deliberate — `recordAudit` is best-effort (it swallows its own errors); we don't await it because audit-log failure must never block the user-facing 200.
- **FR-010** — Success response: `NextResponse.json({ok: true}, {status: 200})`. Exactly that shape; no extra fields, no echoed identity columns, no timestamps.
- **FR-011** — Imports come exclusively from `@gml/db`, `@gml/db/schema`, `@gml/shared/auth/roles`, `@/auth`, `@/lib/audit`, `next/server`, and `drizzle-orm`. No new dependencies, no new helpers — `recordAudit` already exists in `apps/web/src/lib/audit.ts` (verified via Grep before writing).

## Acceptance Criteria

| AC | Behaviour | Verification |
|----|-----------|--------------|
| AC-1 | Route file exists at the documented path | Governance test asserts `existsSync(...)` |
| AC-2 | Exports `POST` handler | Test greps `export async function POST` |
| AC-3 | Exports `GET` handler returning 405 | Test greps `export async function GET` and `405` |
| AC-4 | Role gate covers exactly four roles | Test greps `"super_admin"`, `"programme_admin"`, `"mentor"`, `"observer"` |
| AC-5 | Auth check returns 401 on no session | Test greps `unauthenticated` and `401` |
| AC-6 | Role check returns 403 on wrong role | Test greps `forbidden` and `403` |
| AC-7 | UPDATE scoped to context_type='teach_back' | Test greps `videoSubmissions.contextType` and `"teach_back"` |
| AC-8 | UPDATE sets status to reviewed | Test greps `status: "reviewed"` |
| AC-9 | 404 path on zero-row update | Test greps `not_found` and `404` |
| AC-10 | Audit hook fires with documented action | Test greps `recordAudit\(` and `teach_back\.reviewed` |
| AC-11 | Success response is `{ok: true}` with 200 | Test greps `ok: true` and `status: 200` |
| AC-12 | Imports use locked workspace packages | Test greps `from "@gml/db"`, `from "@gml/db/schema"`, `from "@/auth"`, `from "@/lib/audit"` |

## Schema gaps / deviations

None. `video_submissions.status` is the `video_status` enum which already contains `'reviewed'` (added in spec 036). `audit_log.action` is varchar(64) since spec 021, so the free-form `"teach_back.reviewed"` action string lands without a migration. No new columns, no new enum values, no new indexes.

## Out of scope

- Scoring rubric capture — handled by spec 077 (forms catalog — observation forms).
- Email/WhatsApp notification to the teacher when their submission is marked reviewed — out of Workflow Run 4 scope; if needed it lands as a Phase-11 spec that hooks the audit insert.
- "Un-review" / status revert — the API is unidirectional. A super_admin can revert via `/admin/data/video_submissions` if they need to.
- Bulk-mark-reviewed — not in the brief; queue forces one-by-one review.
- Idempotency tokens — POSTing twice with the same id flips an already-reviewed row to reviewed again (no-op at SQL level since the WHERE finds the row, the SET is identical, and the second audit row gets written). Acceptable — duplicate audit is more honest than silently swallowing the second POST.

## Audit hooks (SM-1)

One free-form action lands in `audit_log.action`:

- `teach_back.reviewed` — entityType `video_submission`, entityId the submission uuid, userId implicit from `recordAudit`'s internal `auth()` call.

## Caller compatibility

Spec 066's form action template is `/api/teach-back/${selected.id}/review` and the form `method="POST"`. The native HTML form submission sends `Content-Type: application/x-www-form-urlencoded` with an empty body — the route does not read `req.body`, so the encoding is irrelevant. After the 200 response the browser navigates to the response URL (the API route itself), which renders as JSON. To return the user to the queue we rely on the queue page being the most recent navigation target; the form does not use `formaction` or `formtarget` redirection, so the user lands on a JSON page. Future polish (out of scope here): a `redirect("/rtt/teach-back?id=...")` after success, but that requires server-action wiring rather than an API route.
