# Research 070
- Drizzle's `asc().nullsFirst()` is not stable across the pg-core minor we ship — using a `sql\`read_at ASC NULLS FIRST\`` literal is the documented escape hatch and matches the `(user_id, read_at, created_at)` index ordering from spec 025.
- Date bucketing is computed in JS from the row `createdAt` against `new Date()` at request time (rather than SQL `date_trunc`) because the row volume is bounded at 50 and the bucket logic is local-time aware (we want IST "Today" not UTC "Today").
