# Research 055
One non-obvious choice: load subjects-per-resource via a single correlated SQL aggregate (`jsonb_agg(subject_name)`) on the index instead of N+1 joins, matching the pattern set in `repo/subjects/page.tsx` (spec 053). Keeps the 80-row index page to one round-trip.
