# Research 026

## D-001: Cookie-hint + matchMedia for hydration safety
Server-only `getDeviceType()` reads a `gml-device` cookie. Client `useDeviceType()` confirms via `matchMedia`. First-visit users get desktop by default (no cookie); the client effect refines and sets the cookie for next request. This avoids a hydration mismatch warning that would fire if server and client diverged on viewport.

## D-002: Route group `(authenticated)` for shell wrapping
Next.js App Router parens-named segments don't appear in the URL but inherit a layout. Every route under `(authenticated)` gets the shell automatically. Public routes (`/login`, `/gate/[slug]`) live outside the group.

## D-003: Tailwind v4 + CSS variables
Tailwind v4 (currently in apps/web/package.json) reads design tokens from CSS variables natively via `@theme`. No `tailwind.config.ts` needed for token extension — the variables become utility classes through CSS-first config.
