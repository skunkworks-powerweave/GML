# Spec 031 — ConfidentialityFooter extension (SM-6)

**Status:** complete (co-shipped with 026)

## Overview

The prototype's confidentiality language is repeated across PDFs (Classroom Observation, Mentorship Template). v2 centralizes it as a single `<ConfidentialityFooter>` component rendered inside both DesktopShell and MobileShell — so every authenticated route inherits it automatically. SM-6 governance test confirms the prop is wired in both shells.

## FRs satisfied

- **FR-001**: `apps/web/src/components/ConfidentialityFooter.tsx` renders the prototype's policy verbatim
- **FR-002**: Footer signs each render with the viewing user's name/email so the message reads "Viewed by <user>" — supports SM-4 anti-download deterrence (watermarking is on the content; this is the page-level disclosure)
- **FR-003**: `compact` prop renders the short variant for mobile
- **FR-004**: Both shells embed it (governance test in 026 asserts this)
