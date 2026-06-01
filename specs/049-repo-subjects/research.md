# Research 049
- Grouped counts (outlines/sessions/readings per subject) are computed in a single round-trip via `sql<number>` aggregates instead of N+1 selects; matches the cost model the index-page would hit in production with ~9 subjects but stays O(1) round-trips as the catalogue grows.
- Subject `color` is stored as a free-form var/hex string in `subjects.color`; we render it as the background of a small dot inline-styled `background: subject.color` rather than picking a chip class — this mirrors the JSX which colors the chip with the subject's own swatch.
