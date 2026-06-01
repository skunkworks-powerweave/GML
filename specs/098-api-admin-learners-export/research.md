# Research 098

## D-001 — Role gate is `super_admin` only (NOT the read-roles list from /repo/students)

Spec 054's `requireRole(["programme_admin", "super_admin"])` is the read-gate for /repo/students — that's the population allowed to *see* learner rows on the screen. SM-9 carves out a narrower bulk-export gate: only `super_admin` can pull the full CSV. The reasoning: PII exposure scales with row count, and a paginated 100-row view is structurally bounded by user attention (a programme_admin reading the screen sees ~100 PII rows per request, audited as `learners.bulk_view`), while a bulk export is one click that exfiltrates the entire dataset to a local file outside the audit window. The narrower gate keeps the export action concentrated on the smaller, more-trusted super_admin population (1–2 people in the Ladakh deployment). Spec 054's acceptance test "bulk CSV export is super_admin-only" already documents this; this route enforces it server-side.

## D-002 — Audit-after-success over audit-on-intent

Two ways to write the audit row: (a) fire BEFORE the SELECT with `rowCount: null` (audit-on-intent — "this user attempted a bulk export, success unknown"); (b) fire AFTER the SELECT with the actual count (audit-after-success). We chose (b) — the auditor's primary use case is post-incident damage assessment ("how many PII rows did this account exfiltrate?"), which requires the actual count. The downside of audit-after — if the SELECT fails between auth and audit, no audit row is written — is acceptable because (i) the SELECT is a single, local, non-transactional query, (ii) a SELECT failure with no audit row also means no CSV was delivered to the user, so there's no exfiltration to investigate, and (iii) the `void` pattern on `recordAudit` means audit failure doesn't block the user, but SELECT failure happens BEFORE the audit call so the audit row would have been skipped anyway in the audit-on-intent model too (auth gate already passed, audit fires, then SELECT crashes — same blank spot).

## D-003 — POST 405 stub vs implicit framework fallback

Next.js App Router auto-returns 405 for unhandled methods, so the explicit `POST()` export is technically redundant. We ship it anyway because (a) the brief implies "GET only" as an explicit assertion, (b) the explicit handler lets us return a JSON body matching our error shape (`{error: "method_not_allowed"}`) instead of the framework's HTML default, and (c) a future Next upgrade changing the implicit fallback won't silently break our contract. PUT/DELETE/PATCH are left to the framework default — the brief never mentions them.

## D-004 — Full SELECT (no LIMIT) at Ladakh seed-data scale

The brief specifies "SELECT all learners". At the worst-case Ladakh seed-data scale (~6 districts × ~10 schools × ~6 grades × ~20 learners ≈ 7,200 rows) a single in-memory `Papa.unparse` call is cheap (rough estimate: ~500 KB CSV, sub-100 ms serialization on a commodity VPS). If the seeded data ever exceeds ~100k rows we'd revisit and switch to streaming serialization, but that's a future-spec problem. The trade-off favors implementation simplicity: a streaming pipeline would require more code and a more complex test surface, neither justified by today's row counts.

## D-005 — Filename uses UTC `YYYYMMDD` (dashes stripped)

`learners-20260601.csv` rather than `learners-2026-06-01.csv`. Some spreadsheet tools auto-detect dashes in filenames as date components and reinterpret the filename in their own locale (Excel on a Spanish locale machine can rewrite the displayed name). Stripping dashes avoids the ambiguity while staying human-readable. UTC (not local time) keeps the filename stable across timezones — two super_admins exporting at the same instant from Leh and Sydney get the same filename.
