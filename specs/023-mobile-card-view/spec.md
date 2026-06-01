# Spec 023 — Mobile card view for admin grid

**Status:** in_progress · **Date:** 2026-06-01 · **Constitution Check:** SM-1 unaffected (no mutations introduced); SM-7 honoured (Hindi name rendered conditionally in `var(--deva)`); SM-9 unaffected — this spec changes only the presentation layer of `[entity]/page.tsx`, the page's existing `recordAudit` call for PII-bearing entities still fires.

## Overview

The generic admin grid at `/admin/data/[entity]` renders a 5–6 column HTML table. On a phone (≤ 768px) that table is horizontally scrollable and unusable. This spec ships a card-based mobile fallback while leaving the desktop table untouched. The page picks the layout at SSR time using the existing `getDeviceType()` cookie-based detector from spec 026.

The mobile component receives the entity's `displayColumns` directly from the admin registry — there is no new schema or registry field. The first display column becomes the card title; the next 2-3 become KV pairs inside the card body. Each card has an Export CSV affordance (anchored at the same `/api/admin/data/[slug]/export` endpoint the desktop header uses) and a "View row" affordance.

## User Stories

**US1** (Programme admin on phone): visit `/admin/data/teachers` → see a vertical stack of teacher cards, each showing Name + School + Phone + Subject, with the Hindi name rendered under the English name when present (SM-7). Tap "View row" to deep-link to the row, tap "Export CSV" to download.

**Independent Test**: load `/admin/data/teachers` with `gml-device=mobile` cookie → page renders `<MobileEntityCardList>` instead of `<table>`. Set the cookie to `desktop` → table renders, card list is not in the DOM (it sits inside a `device === "mobile"` ternary, so the JSX never instantiates on desktop).

**US2** (Programme admin on phone, empty entity): visit `/admin/data/zones` when no zones exist → card list shows a dashed empty-state with "No zones yet. Use the form above to add one."

## Functional Requirements

- **FR-001**: `apps/web/src/admin/components/MobileEntityCardList.tsx` exists as a client component (`"use client"`) and exports `MobileEntityCardList` plus the `MobileCardColumn` and `MobileEntityCardListProps` types.
- **FR-002**: Component accepts props `{ entitySlug, entityLabel, rows, columns, maxKvFields? }`. `columns[0]` is treated as the title column; `columns.slice(1, 1 + maxKvFields)` (default `maxKvFields = 3`) becomes the KV pairs.
- **FR-003**: Card visual matches GML tokens — `background: var(--card-hi)`, `border: 1px solid var(--line)`, `border-radius: var(--r-3)`, `padding: 14`, `gap: 8`. Title uses `var(--serif)` at 16px. KV labels are uppercase 10px tracking `0.07em` color `var(--ink-3)`.
- **FR-004**: SM-7: if the row carries a `hindiName` or `nameHindi` string field with a non-empty value, render it inline next to the title using `font-family: var(--deva)`. Never render anything when the field is null/undefined/empty.
- **FR-005**: Each card has two action buttons: "Export CSV" links to `/api/admin/data/{slug}/export`; "View row" links to `/admin/data/{slug}?row={encoded id}`. Both render even when the row has no id (the View link falls back to the entity list URL).
- **FR-006**: Empty `rows` array renders a dashed-border empty-state card with a label-aware message.
- **FR-007**: `apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx` calls `getDeviceType()` and conditionally renders `<MobileEntityCardList>` when device is `mobile`, with the existing `<table>` hidden via `display: none` + `aria-hidden`. The table JSX is preserved verbatim for desktop — no behavioural changes on desktop.
- **FR-008**: Mobile pagination: when device is mobile, page also gets a Prev / Page n / Next nav (re-uses the same `?page=` querystring the desktop nav uses).
- **FR-009**: No new admin entity schema additions; the component reads `entity.displayColumns` as the source of truth for title + card fields. No `cardFields` or `titleField` registry keys are introduced (would have required an `AdminEntity` type change for zero functional gain — `displayColumns` already orders the canonical name first).

## Independent Test

```powershell
pnpm test -- tests/governance/test_023_mobile_card_view.test.mjs
```

Manual smoke (when local stack is up):
1. `document.cookie = "gml-device=mobile; path=/"` in DevTools, refresh `/admin/data/teachers` — card list renders, table is `display:none`.
2. Clear cookie, refresh — table renders, no `data-testid="mobile-cards-*"` element in DOM.
3. Add a teacher with Hindi name → mobile card shows English name then Devanagari subtitle.

## Out of scope

- Replacing the desktop table with cards (desktop table stays).
- Inline edit on mobile cards (row-form mutations still happen on the create form above).
- Per-row delete from mobile cards (deferred — the View row link lands on the table view where Delete already exists).
- Adding `cardFields`/`titleField` to `AdminEntity` type (designed around `displayColumns` order; revisit if a future entity needs a non-first title field).
