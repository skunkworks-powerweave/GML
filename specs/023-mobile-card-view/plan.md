# Plan 023

CREATED: `apps/web/src/admin/components/MobileEntityCardList.tsx`, `tests/governance/test_023_mobile_card_view.test.mjs`, `specs/023-mobile-card-view/{spec,plan,research,quickstart,tasks}.md`
EDITED: `apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx` — import `getDeviceType` + `MobileEntityCardList`, conditionally render cards for `device === "mobile"`, hide existing table on mobile via inline `display:none`, add mobile pagination nav.
MIGRATED: none — no schema changes, no new registry fields (re-uses `AdminEntity.displayColumns`).
