# Spec 035 — Section-gate page re-skin

**Status:** in_progress · **Date:** 2026-06-01

## Overview

Re-skins `/gate/[slug]` to a centered card on parchment with a lock badge, slug-specific tagline, password input (monospace + letter-spaced), and the rate-limit explanation in fine print.

## FRs

- **FR-001**: Centered card layout (max-width 440px) on `var(--paper)` background
- **FR-002**: Lock SVG badge top-left (saffron-soft tile)
- **FR-003**: Slug-specific titles + taglines for `mentorship`, `observation`, `admin`, `tkt`, `ttt`
- **FR-004**: Password input is `font-family: var(--mono)` + `letter-spacing: 0.1em` so dots are visually distinct
- **FR-005**: Footer in the card explains 8h grant + 5/15min rate-limit + back-to-dashboard link
- **FR-006**: Reuses existing `verifyGate` server action (no behavior change)
