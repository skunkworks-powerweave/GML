# Spec 034 — Login page re-skin

**Status:** in_progress · **Date:** 2026-06-01

## Overview

Re-skins `/login` to match `LMS GML Frontend/login.jsx`. Two-pane: left brand panel with mountain SVG, gradient sky, tagline, and stat row; right form panel with Password / Magic-link tab switch. Drops the prototype's demo-role picker (production users sign in with real credentials). Drops Phone+OTP (not in scope).

## FRs

- **FR-001**: Two-column layout (1.05fr / 1fr) with brand left, form right.
- **FR-002**: Left pane renders the prototype's mountain composition SVG verbatim (indigo gradient sky, layered peaks, saffron sun) + GML wordmark + tagline + 4-stat row.
- **FR-003**: Right pane has Password/Magic-link tab toggle. Password tab uses existing `loginAction`; Magic-link tab uses existing `EmailLinkForm` component.
- **FR-004**: Language hint row at the bottom of the form pane (EN/हिन्दी/Ladakhi labels).
- **FR-005**: Page is `'use client'` (uses `useActionState` + tab state).
