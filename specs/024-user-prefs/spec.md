# Spec 024 — user_prefs table + GET/PUT API + audit-on-change

**Status:** in_progress · **Date:** 2026-06-01

## Overview

Persist the Tweaks Panel's settings per-user. The prototype's `useTweaks` hook stores in localStorage; production stores server-side in `user_prefs`. Same shape (density/nav style/font scale/a11y/watermark/language/FTUX seen).

## FRs

- **FR-001**: `packages/db/src/schema/prefs.ts` exports `userPrefs` (pgTable `user_prefs`). One row per user; `user_id uuid PRIMARY KEY` FK users.id ON DELETE CASCADE. 4 CHECK constraints validating the enum-like varchar fields.
- **FR-002**: `apps/web/src/app/api/user-prefs/route.ts` exposes GET (returns row or defaults) and PUT (upsert + audit-on-change with action `user_prefs.update`).
- **FR-003**: Migration `0011_user_prefs_and_notifications.sql` (combined with spec 025 since the two land together).
- **FR-004**: Governance test asserts schema + API surface + audit hook.
