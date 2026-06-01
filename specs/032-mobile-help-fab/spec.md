# Spec 032 — Mobile help FAB

**Status:** in_progress · **Date:** 2026-06-01

## Overview

Floating ? button + bottom-sheet help dialog rendered inside MobileShell. Ports `mobile-shell.jsx`'s help FAB minus the dictionary-driven HelpPanel (spec 029 dropped). Content is a static 5-bullet quick-orientation message — enough for teachers landing in the app for the first time without a full FTUX tour.

## FRs

- **FR-001**: `apps/web/src/components/MobileHelpFAB.tsx` — `'use client'`, fixed bottom-right above bottom tabs, 44×44 circular button with ? glyph
- **FR-002**: Click opens a bottom-sheet dialog with 5 bullets: bottom-nav usage, WhatsApp upload, direct upload, confidentiality, password help
- **FR-003**: Sheet dismisses on backdrop click or Close button
- **FR-004**: MobileShell embeds `<MobileHelpFAB />` after the main content; safe-area-inset handled
