# Spec 018 — Resources (reading material) + resource↔subjects join

**Status:** in_progress · **Date:** 2026-06-01

## Overview

`resources` are named reading materials (PDFs / guides / handbooks / policy docs / worksheets / templates / routines / calendars / checklists / lab guides) accessible from the repository. Many-to-many with curriculum subjects via `resource_subjects`.

## FRs

- **FR-001**: `packages/db/src/schema/resources.ts` exports `resources` and `resourceSubjects` (join).
  - `resources`: id, `name varchar(240)`, `kind varchar(40)` (CHECK in set), `owner varchar(120)`, `pages int CHECK > 0`, `file_key text` (MinIO; lands properly in spec 037), `external_url text`, `tags jsonb DEFAULT '[]'`, `active boolean DEFAULT true`, timestamps. CHECK `file_key IS NOT NULL OR external_url IS NOT NULL` (must have at least one source).
  - `resource_subjects`: composite PK `(resource_id, subject_id)` with FKs to resources.id ON DELETE CASCADE and subjects.id ON DELETE CASCADE.
- **FR-002**: barrel + 2 admin entities (slugs `resources` + `resource-subjects`).
- **FR-003**: migration `0007_resources.sql` (descriptive rename).
- **FR-004**: governance test.
