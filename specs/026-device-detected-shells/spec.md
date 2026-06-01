# Spec 026 — Device-detected shells

**Status:** in_progress · **Date:** 2026-06-01

## Overview

Ship the chrome foundation that wraps every authenticated route. Single Next.js App Router app, two device-detected shells (`<DesktopShell>` / `<MobileShell>`) selected by viewport. Sidebar (desktop) and bottom tabs (mobile) both consume the same role-aware `NAV_BY_ROLE` map ported 1:1 from `LMS GML Frontend/shell.jsx`.

## FRs

- **FR-001**: `apps/web/src/lib/device.ts` exports `getDeviceType()` (server) and `useDeviceType()` (client). Server reads UA cookie (`gml-device` set on first request). Client uses `matchMedia('(max-width: 768px)')`.
- **FR-002**: `apps/web/src/config/nav.ts` exports `NAV_BY_ROLE: Record<RoleName, NavSection[]>` ported verbatim from `shell.jsx`.
- **FR-003**: `apps/web/src/components/nav/Sidebar.tsx` renders the desktop sidebar (4-section grouped nav with counts + gate badges).
- **FR-004**: `apps/web/src/components/nav/BottomTabs.tsx` renders the mobile bottom tabs (5 tabs/role from `mobile-shell.jsx::TABS_BY_ROLE`).
- **FR-005**: `apps/web/src/components/shells/DesktopShell.tsx` wraps children with sidebar + topbar slot + content + footer slot.
- **FR-006**: `apps/web/src/components/shells/MobileShell.tsx` wraps children with topbar slot + content + bottom tabs.
- **FR-007**: `apps/web/src/app/(authenticated)/layout.tsx` selects shell based on `getDeviceType()` and wraps children.
- **FR-008**: `apps/web/src/app/globals.css` defines GML CSS variables (`--ink`, `--paper`, `--saffron`, etc.) from prototype's `app.css`.
- **FR-009**: `apps/web/tailwind.config.ts` extends color tokens to use the CSS variables.
- **FR-010**: Governance test asserts NAV_BY_ROLE has all 5 roles, shells render children prop, layout selects via device type.

## Independent Test
viewport ≥ 769px → desktop sidebar visible; viewport ≤ 768px → bottom tabs visible. Both render the same routes for a given role.
