# Research 046
- Week range is computed server-side from `new Date()` rather than hardcoded (`2026-05-18`..`2026-05-22` in JSX prototype) so the page stays useful past launch week.
- All eight counts run in parallel via `Promise.all` to avoid a 6× serial-roundtrip on first paint.
