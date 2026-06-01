# Spec 098 — GET /api/admin/learners/export (super_admin-only bulk learner CSV)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** Workflow Run 4 (API endpoint closure).

## Overview

Implements the API endpoint that spec 054 (/repo/students learner index) pointed its "Export CSV" anchor at but never owned. The route is a single Next.js App-Router file at `apps/web/src/app/api/admin/learners/export/route.ts` exporting `GET` (the happy path, returns `text/csv` attachment) and `POST` (returns 405 so the route does not silently swallow misrouted POSTs from a future client-side form attempting to upload an export-config payload).

The caller is a plain `<a href="/api/admin/learners/export?school=<uuid?>">` rendered inside the page header of `/repo/students` only when the resolved session role === `"super_admin"`. The link is a native anchor, not a `<form>` — the browser navigates to the URL in a new document context, the server response declares `Content-Type: text/csv; charset=utf-8` plus `Content-Disposition: attachment; filename="learners-YYYYMMDD.csv"`, and the file lands in the user's downloads folder. The optional `?school=<schoolId>` query param is mirrored from the caller's own school filter (when /repo/students was loaded with `?school=<uuid>`, the Export CSV anchor forwards the same uuid so the CSV matches the on-screen filter).

The endpoint is auth-gated by `auth()` from `@/auth` (NextAuth session) and role-gated **specifically and only** to `super_admin` — this is the SM-9 PII policy split: `programme_admin` can VIEW /repo/students (paginated, audited as `learners.bulk_view`) but cannot bulk-export the full CSV. The spec 054 acceptance test "bulk CSV export is super_admin-only" already documents this; the route enforces it. A `programme_admin` POSTing manually with a forged auth cookie still gets 403.

The route SELECTs all learners with `learners.active = true AND learners.deleted_at IS NULL`, optionally filtered by `learners.school_id = <schoolFilter>`, joined to `classes` (for `class_label`) and `schools` (for `school_code`), ordered by `schools.code → learners.grade → learners.name` (the same ordering /repo/students uses for visual continuity between the on-screen table and the CSV). No `LIMIT` — `super_admin` is by definition trusted to read the whole table, and the SELECT is local so a full table dump is cheap enough at the seed-data scale (Ladakh: ~6 districts × ~10 schools × ~6 grades × ~20 learners ≈ 7,200 rows worst case).

CSV serialization uses `papaparse` (already in `apps/web/package.json`, ^5.4.1, used by `apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts`). No new dependency. Columns in order: `id, name, age, grade, school_code, class_label, guardian, attendance_pct`. The `class_label` column is rendered as `"Grade N"` to match the on-screen text in /repo/students (so a copy-pasted classroom roster stays semantically aligned between the UI and the CSV).

Filename uses today's UTC date in `YYYYMMDD` form — `learners-20260601.csv`. The dashes are stripped so spreadsheet tools that auto-detect date-like filenames don't reinterpret them. The filename is built once per request from `new Date().toISOString().slice(0, 10).replace(/-/g, "")`.

Audit hook (SM-9): `recordAudit({action: "learners.bulk_export", entityType: "all", metadata: {piiAudited: true, rowCount, schoolFilter}})`. The audit fires **after the SELECT completes** so `rowCount` is the actual number of exfiltrated rows (audit-on-intent was considered and rejected — see research.md D-002). The userId is grabbed implicitly by `recordAudit` from its internal `auth()` call. The audit is fire-and-forget (`void`) so an audit-log insert failure never blocks the user-facing 200 — under SM-9 the audit row is preferred but the export must still complete (a half-finished CSV with no audit row is worse than a complete CSV with a logged audit-write failure in stderr).

## Functional Requirements

- **FR-001** — Route file lives at `apps/web/src/app/api/admin/learners/export/route.ts`, declares `export const dynamic = "force-dynamic"` (never cache — every request must re-run the auth gate and produce fresh data).
- **FR-002** — Exports an async `GET(req)` handler accepting the standard Next App-Router `Request`. The handler reads `?school` from `new URL(req.url).searchParams`.
- **FR-003** — Exports an async `POST()` handler that returns `NextResponse.json({error: "method_not_allowed"}, {status: 405})`. We don't bother with PUT/DELETE/PATCH stubs — Next's default 405 fallback covers those, but an explicit POST stub is load-bearing because a future spec might wire a `<form method="POST">` to this endpoint by mistake and we want the response to be a clean 405 with our JSON shape rather than the framework's HTML default.
- **FR-004** — Auth gate: `const session = await auth()`. If `!session?.user?.id`, return 401 `{error: "unauthenticated"}` as JSON. No redirect — this is an API route, not a page.
- **FR-005** — Role gate: `session.user.role === "super_admin"`. Failure returns 403 `{error: "forbidden"}` as JSON. The allowed-role list lives in `ALLOWED_ROLES = ["super_admin"] as const` for IDE intellisense; the test asserts the source contains `"super_admin"` and explicitly does NOT contain `"programme_admin"` in the role check (to lock in the SM-9 policy split).
- **FR-006** — Query string: `const url = new URL(req.url); const schoolFilter = url.searchParams.get("school") || undefined;`. Empty string and missing param both collapse to `undefined` (drizzle then omits the school predicate from the WHERE).
- **FR-007** — SQL: `db.select({ ...projection }).from(learners).leftJoin(classes, eq(learners.classId, classes.id)).leftJoin(schools, eq(learners.schoolId, schools.id)).where(<active + not-deleted + optional school filter>).orderBy(asc(schools.code), asc(learners.grade), asc(learners.name))`. No `.limit()` — full table dump is intentional.
- **FR-008** — CSV columns and order: `id, name, age, grade, school_code, class_label, guardian, attendance_pct`. NULL columns serialize as empty strings (`""`), not the literal text `"null"`. The `class_label` is rendered as `"Grade <N>"` for non-null `classes.grade`, else `""`.
- **FR-009** — `Papa.unparse({fields: headers, data})` produces the CSV body. Headers come first (Papa's default), one row per learner.
- **FR-010** — Response: `new Response(csv, {status: 200, headers: {"Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="learners-YYYYMMDD.csv"'}})`. The `attachment` disposition forces the browser to save rather than render inline.
- **FR-011** — Filename: `learners-${YYYYMMDD}.csv` where `YYYYMMDD` is `new Date().toISOString().slice(0, 10).replace(/-/g, "")`. UTC, no timezone shift.
- **FR-012** — Audit hook (SM-9): `void recordAudit({action: "learners.bulk_export", entityType: "all", metadata: {piiAudited: true, rowCount: rows.length, schoolFilter: schoolFilter ?? null}})`. The `void` is deliberate — best-effort. The audit fires AFTER the SELECT (audit-after-success), never before (research.md D-002).
- **FR-013** — Imports come exclusively from `@gml/db`, `@gml/db/schema`, `@/auth`, `@/lib/audit`, `next/server`, `drizzle-orm`, and `papaparse`. No new dependencies.

## Acceptance Criteria

| AC | Behaviour | Verification |
|----|-----------|--------------|
| AC-1 | Route file exists at the documented path | Governance test asserts `existsSync(...)` |
| AC-2 | Exports `GET` handler | Test greps `export async function GET` |
| AC-3 | Exports `POST` 405 stub | Test greps `export async function POST` and `405` |
| AC-4 | Auth check returns 401 on no session | Test greps `unauthenticated` and `401` |
| AC-5 | Role gate is `super_admin` ONLY (not programme_admin) | Test greps `"super_admin"` and asserts no `"programme_admin"` token appears in the role check |
| AC-6 | Role check returns 403 on wrong role | Test greps `forbidden` and `403` |
| AC-7 | SELECT joins learners + classes + schools | Test greps `leftJoin(classes` and `leftJoin(schools` |
| AC-8 | WHERE includes `deleted_at IS NULL` | Test greps `isNull(learners.deletedAt)` |
| AC-9 | Audit hook fires `learners.bulk_export` with rowCount | Test greps `"learners.bulk_export"`, `piiAudited: true`, `rowCount` |
| AC-10 | papaparse is used for CSV stringify | Test greps `Papa.unparse(` and `from "papaparse"` |
| AC-11 | Response is text/csv with attachment disposition + dated filename | Test greps `text/csv`, `Content-Disposition`, `attachment`, `learners-` |
| AC-12 | Imports use locked workspace packages | Test greps `from "@gml/db"`, `from "@gml/db/schema"`, `from "@/auth"`, `from "@/lib/audit"` |
| AC-13 | `dynamic = "force-dynamic"` | Test greps the literal export |

## Schema gaps / deviations

None. The route rides existing tables:

- `learners` (spec 019) — `id, name, age, grade, school_id, class_id, guardian, attendance_pct, active, deleted_at`.
- `classes` (spec 015) — `id, grade`.
- `schools` (spec 014 / geography) — `id, code`.
- `audit_log.action` is `varchar(64)` since spec 021, so the free-form `"learners.bulk_export"` action string lands without a migration.

No new columns, no new enum values, no new indexes.

## Out of scope

- An admin-side "Audit access log" UI surfacing recent `learners.bulk_export` rows — out of Workflow Run 4 scope; if needed it lands as a Phase-11 spec that reads from `audit_log` with the `action='learners.bulk_export'` filter.
- Streaming CSV generation for very large tables — at the Ladakh seed-data scale (~7,200 rows worst case) a single in-memory `Papa.unparse` is cheap. If the seeded data ever exceeds ~100k rows we'd revisit and switch to `Papa.unparse(..., { quoteChar: '"', skipEmptyLines: true })` over an async iterator, but that's a future-spec problem.
- Column filtering / multi-school filtering / date-range filtering — the brief specifies a single optional `?school=<uuid>` filter and the full column set. Anything richer is a separate spec.
- Email-delivered CSV (asynchronous bulk export) — sync attachment is the contract.
- A separate `programme_admin` "limited export" with PII columns scrubbed — explicitly not requested. SM-9 says programme_admin gets paginated view but no bulk export, period.

## Audit hooks (SM-9)

One free-form action lands in `audit_log.action`:

- `learners.bulk_export` — entityType `all`, no entityId, metadata `{piiAudited: true, rowCount: <int>, schoolFilter: <uuid | null>}`. UserId is implicit from `recordAudit`'s internal `auth()` call.

## Caller compatibility

Spec 054's anchor template is `/api/admin/learners/export${schoolFilter ? `?school=${encodeURIComponent(schoolFilter)}` : ""}` (lines 87–104 of `apps/web/src/app/(authenticated)/repo/students/page.tsx`). The anchor only renders when `isSuperAdmin === true` (gated client-side by the session role resolved at server-render time). The server-side role gate inside this route is the authoritative enforcement — a forged anchor injected via DevTools by a `programme_admin` would still get 403.

After the browser receives the response, it sees the `Content-Disposition: attachment` header and saves the file to the downloads directory rather than navigating to it. The user stays on /repo/students. No client-side JavaScript is involved on either side.
