# Spec 011 — Substrate Moat Tests

**Status:** in_progress · **Constitution:** SM-1..SM-6 enforcement layer.

## Overview
Codify the substrate moats as CI gates + raw SQL migrations. Each moat must be defended at multiple layers per PLAN.md § "Substrate moats". This spec is the lock-in: future specs that violate a moat fail their tests.

## Functional Requirements
- **FR-001 (SM-1 grep gate)**: `tests/governance/test_011_sm1_audit_append_only.test.mjs` — recursively greps `apps/web/src` and `packages/db/src` for `db.update(auditLog)` / `db.delete(auditLog)` / `auditLog).set(` / `delete(auditLog)`. Must find zero hits.
- **FR-002 (SM-1 DB layer)**: `packages/db/src/migrations/_post/001_revoke_audit_writes.sql` — `REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC, gml;` applied after drizzle-kit generates the base schema. The migrator runs `_post` SQL files after the auto-generated migrations.
- **FR-003 (SM-2 CHECK)**: gates schema already has the CHECK from spec 008; this spec asserts it.
- **FR-004 (SM-4 deterrence disclosure)**: README-IT.md must include the "deterrence, not prevention" sentence; CI gate.
- **FR-005 (SM-5 restore drill)**: `scripts/check-restore-drill.mjs` reads `workspace/last_restore_drill.json` and exits non-zero if older than 30 days; deploy script (spec 067) calls it.
- **FR-006 (SM-6 confidentiality footer)**: page-level audit test — every page under `/observation/*`, `/rtt/*`, `/mentorship/*`, `/admin/*` must contain the confidentiality footer string. Deferred to spec 070 when all pages exist; this spec ships the test runner stub.

## Deferred
- SM-3 (video originals retained) — depends on video pipeline (spec 022+). Test added in spec 027 alongside HLS player.
- SM-6 page-by-page check — runs only against pages that exist; will tighten in spec 070.
