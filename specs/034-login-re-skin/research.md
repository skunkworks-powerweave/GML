# Research 034

## D-001: Inline mountain SVG over an image asset
Prototype uses inline SVG (≈12 lines of path data). Inline keeps the page single-file, parses in HTML stream, and zero asset to ship. Bundle-size cost ≈ 1.5KB. Acceptable.

## D-002: Drop the demo-role picker
Prototype's role tabs were a click-to-impersonate affordance for demoing the UX. Production uses real credentials; the picker is removed entirely.

## D-003: Tabs as state, not URL
Password vs Magic-link is ephemeral UI state — no SEO benefit to URL routing it. `useState`.
