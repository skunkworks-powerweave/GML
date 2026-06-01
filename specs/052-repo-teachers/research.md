# Research 052

## D-001: Aggregate counters as inline subqueries, not separate fetches

The prototype shows sessions# and observation cycles# per teacher in the index table. Computing those with two extra `db.select()` calls inside `.map()` would N+1. Built the counts as Drizzle `.as("session_counts")` / `.as("cycle_counts")` subqueries grouping by `teacherId`, then `leftJoin` into the main query — a single round-trip that scales fine for ~50 teachers and keeps the page well under the 1s SSR budget.
