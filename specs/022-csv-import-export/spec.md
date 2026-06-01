# Spec 022 — CSV import/export for admin grids

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-9 reinforced — `learners.bulk_export` requires `super_admin` role explicitly.

## Overview

Every admin entity gets two routes:
- `GET /api/admin/data/[entity]/export` → text/csv download (one row per DB row, columns ordered by `entity.displayColumns`).
- `POST /api/admin/data/[entity]/import` → consume CSV body, validate each row via `entity.formSchema`, bulk-insert via `withAudit`. Returns `{ ok, inserted, skipped, errors[] }`.

Admin grid (`/admin/data/[entity]`) gains an "Export CSV" link. (Import UI lands as a small upload form in spec 023 mobile card view's polish pass.)

## FRs

- **FR-001**: `apps/web/src/app/admin/data/[entity]/csv.ts` — `exportCsv(slug)` + `importCsv(slug, csv)` server helpers. Uses `papaparse`.
- **FR-002**: Route `/api/admin/data/[entity]/export` GET → text/csv.
- **FR-003**: Route `/api/admin/data/[entity]/import` POST → JSON summary.
- **FR-004**: `learners` exports require `super_admin` (SM-9 strengthening).
- **FR-005**: All imports/exports audit-logged with action `${slug}.bulk_import` / `${slug}.bulk_export`.
- **FR-006**: papaparse dep added to `apps/web/package.json`.
