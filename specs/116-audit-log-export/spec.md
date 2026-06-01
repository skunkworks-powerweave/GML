# 116 — Audit log CSV export

## Problem

Frontend-parity gap. The JSX prototype `LMS GML Frontend/admin.jsx::AuditLog`
(line 252) renders a download-icon "Export" button on the `/admin/audit` page,
but the real Next.js implementation at
`apps/web/src/app/(authenticated)/admin/audit/page.tsx` ships only the filter
form and the paged table — the Export button has no wiring, and no
`/api/admin/audit/export` endpoint exists.

Operators triaging an incident, compliance reviewers preparing the 7-year
retention dump, and audit responders needing the slice of the log for a
specific window all want a CSV they can attach to a ticket or load into a
spreadsheet. Forcing them to scroll the paged HTML view + screenshot rows is
not viable.

## Goal

Wire the prototype's "Export" affordance to a real backend so a programme_admin
or super_admin viewing `/admin/audit?action=gate_fail&user=<uuid>` can click
"Export CSV" and get the filtered slice as `audit-log-YYYYMMDD.csv` — and the
export itself is recorded as `audit.bulk_export`.

## Non-goals

- No new audit-log filters beyond what the page exposes today (action, user) —
  the route accepts a documented superset (entityType, from, to) for
  future use but the page does not surface those controls yet.
- No streaming response. v1 buffers up to 10000 rows in memory, well within
  Node's default heap for jsonb metadata-shaped rows.
- No CSV-injection sanitization for cells that start with `=`/`+`/`-`/`@`.
  The audit log is consumed by trusted operators only; SC-2 will revisit if
  the export is ever surfaced to less-trusted roles.
- No PDF or XLSX export. CSV is enough for v1.
- The admin/audit page does not yet surface entityType/from/to UI controls
  even though the API accepts them — that's a separate UX polish spec.

## API contract

`GET /api/admin/audit/export`

Auth:
- 401 `unauthenticated` if no session
- 403 `forbidden` if session.user.role not in {super_admin, programme_admin}

Query params (mirror the `/admin/audit` page + documented superset):
- `action` — exact-match on `audit_log.action`
- `user` — exact-match on `audit_log.user_id` (page-side alias)
- `userId` — canonical alias of `user`
- `entityType` — exact-match on `audit_log.entity_type`
- `from` — ISO timestamp; `created_at >= from`
- `to` — ISO timestamp; `created_at < to`

Response (200):
- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="audit-log-YYYYMMDD.csv"`
- Columns: `timestamp, action, actor_user_id, entity_type, entity_id, ip,
  user_agent, metadata` — metadata is JSON-stringified.

Error responses:
- 413 `too_many_rows` if the filtered set exceeds 10000 rows. JSON body
  carries a `hint` field telling the caller to narrow by `from`/`to`/`action`
  /`userId`. We probe with `LIMIT cap+1` to avoid a separate `COUNT(*)`.
- 405 on POST.

Audit hook:
- `recordAudit({ action: "audit.bulk_export", entityType: "audit_log",
  metadata: { rowCount, filters } })` fires after the SELECT so `rowCount` is
  accurate. Best-effort `void` so audit-insert failure never blocks the 200.

## UI wiring

`apps/web/src/app/(authenticated)/admin/audit/page.tsx` already builds the
filter form. We:
1. Compute `exportHref` server-side from the current `searchParams` (drops
   `page` so the CSV always covers the full filtered slice).
2. Render a `<Link href={exportHref} download>Export CSV</Link>` inside the
   filter form, right of the "Filter" submit button.

The link is a plain anchor with `download` — the browser hits the endpoint as
a GET, the response declares `attachment`, the file lands in the user's
download directory. No JS state, no client component boundary.

## Verification

- pnpm test -- tests/governance/test_116_audit_log_export
- Manual: log in as programme_admin, visit `/admin/audit?action=login`, click
  "Export CSV", confirm `audit-log-YYYYMMDD.csv` downloads with login rows
  only, and confirm `/admin/audit` shows a new `audit.bulk_export` row at
  the top of the table.
