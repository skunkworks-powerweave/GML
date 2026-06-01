# Research 019

## D-001: SM-9 enforcement layer choice
Three options for "audit-on-read":
1. **Generic page wrapper** (chosen): the admin grid page checks `entity.piiAudited` and calls `recordAudit` after the fetch. Pros: zero code in entity definition beyond the flag. Cons: only catches admin reads; future repo/student pages (spec 054) need their own audit calls.
2. Drizzle middleware on every SELECT: too invasive; many internal queries shouldn't audit.
3. Postgres RLS trigger emitting NOTIFY: elegant but couples PG-side to app-side audit_log shape.

Option 1 is minimal + reuses existing `recordAudit`.

## D-002: Soft delete for learners
`deleted_at` enables GDPR-style erasure-on-request without removing audit_log entries that reference the learner id. Spec 091 backup/restore can additionally encrypt-at-rest.

## D-003: `attendance_pct` denormalized
Real attendance comes from `sessions` (attended_count vs total_count). The denormalized `attendance_pct` on `learners` is a cached aggregate for fast list views — recomputed by a future scheduled job (out of v2 scope; nightly recompute in spec 094 hardening).

## D-004: `age` range 3..25
3 = preschool floor (pre-primary). 25 = upper bound for late-life literacy learners in remote Ladakh schools. NULL allowed for "not disclosed".
