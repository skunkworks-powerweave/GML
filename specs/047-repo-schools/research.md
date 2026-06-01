# Research 047
- Schools listing aggregates teacher/class/session counts via inline correlated subqueries (not a separate `school_stats` view) — keeps the route a single round-trip and avoids a materialised view migration.
- District filter is `?district=` searchParam (server-side) rather than client state, so the route is shareable and SSR-cacheable per filter.
