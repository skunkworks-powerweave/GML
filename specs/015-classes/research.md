# Research 015

## D-001: `stage` is varchar(16), not an enum

Ladakh schools use "Primary" (grades 1-5), "Middle" (6-8), "High" (9-12). Could be an enum — but varchar with a CHECK or app-layer Zod is more flexible (e.g., partner orgs might add "Pre-Primary"). Keep flexible.

## D-002: `students_count` is denormalized

A learners count derived from `learners` table (spec 019) would always be accurate but query-expensive on every list view. Denormalize, update via trigger or app-layer hook on learner insert/delete.

## D-003: UNIQUE `(school_id, grade)`

A class is uniquely identified by (school, grade). If a school has two sections of Grade 5 (e.g. "5A" and "5B"), they're modeled as the same `classes` row with `sections_count=2`. Section-level granularity lands later if needed.
