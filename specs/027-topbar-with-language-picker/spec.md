# Spec 027 — Topbar with language picker + bell + user pill

**Status:** complete (co-shipped with 026)

## Overview

Per spec 026's research note D-001, the Topbar was built alongside DesktopShell since it's the only component that uses it. This spec formally claims:

- `apps/web/src/components/nav/Topbar.tsx` — breadcrumbs + bell (badge wired in spec 070) + EN/HI/BO language picker (real persistence wired in spec 071) + user pill with sign-out

## FRs satisfied

- **FR-001**: Topbar renders breadcrumbs from props
- **FR-002**: Bell icon present (badge count comes from /api/notifications/poll in spec 070)
- **FR-003**: Language picker shows EN / हिन्दी / Ladakhi (لد) — Devanagari + Arabic-script labels
- **FR-004**: User pill shows initials + name + role label; clicking signs out via Auth.js server action
