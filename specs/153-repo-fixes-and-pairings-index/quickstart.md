# Quickstart 153 — Repo detail fixes + mentor_pairings.teacher_id index

Three manual smoke checks plus one EXPLAIN trace. Total ~6 minutes.

## (A) /repo/mentor/[id] — soft-retired mentor no longer renders

1. Boot `pnpm dev` + the docker-compose db / redis / minio.
2. Sign in as a `programme_admin` or `super_admin`.
3. Visit `/repo/mentors`. Pick any mentor and open the detail page.
   The profile renders.
4. In a separate psql session (or the Drizzle Studio), flip the
   mentor's `active` flag to false:
   ```sql
   UPDATE mentors SET active = false WHERE id = '<mentor-id>';
   ```
5. Refresh the detail page. It now returns the 404 page (Next.js
   `notFound()`) instead of the cached profile.
6. Visit `/repo/mentors`. The soft-retired mentor no longer appears
   in the list (pre-fix this was already the case). The new fix
   closes the gap so the detail URL behaves consistently.
7. Restore: `UPDATE mentors SET active = true WHERE id = '<id>';`

## (B) /repo/sessions — malformed date filter no longer 500s

8. Sign in as a `mentor` / `observer` / `teacher` / `programme_admin`.
9. Visit `/repo/sessions`. The list renders normally.
10. Construct a malformed URL by hand:
    `/repo/sessions?from=2026-13-45`
11. Open it. Pre-fix the page returned a 500 with a Postgres
    `date/time field value out of range` error. Post-fix the page
    renders the unfiltered list (the malformed `from` value silently
    drops). The "from" input on the filter form is empty (because
    the filter wasn't applied), and the user can proceed normally.
12. Try a Feb-30 variant: `/repo/sessions?from=2026-02-30`. Same
    behaviour — filter dropped silently, list renders.
13. Try a valid date: `/repo/sessions?from=2026-06-15`. Filter
    applies; the from-input retains the value.

## (C) Mentor-pairings teacher-id index — EXPLAIN trace

14. Run the migration if not already applied:
    ```bash
    pnpm --filter @gml/db migrate
    ```
15. Confirm the index exists:
    ```sql
    \d mentor_pairings
    -- look for: "mentor_pairings_teacher_idx" btree (teacher_id)
    ```
16. EXPLAIN a teacher-detail query:
    ```sql
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT * FROM mentor_pairings
    WHERE teacher_id = '<a-real-teacher-uuid>';
    ```
    Look for `Index Scan using mentor_pairings_teacher_idx` in the
    plan (vs the pre-fix `Seq Scan on mentor_pairings`). At the
    current 120-row scale both run in <1 ms; the win shows up at
    the projected 5000-row scale.
17. Visit `/repo/teacher/<id>` for a teacher with at least one
    pairing. The detail page renders the active-mentor card and the
    pairing history — both query paths now use the index.

## Desktop / mobile parity check

18. Verify the mobile shells (spec 137-138) still render the
    sessions list. Resize the browser to ≤ 768 px or set the
    `gml-device=mobile` cookie. The card list renders; the date
    filter still works.

## Test gate

19. Run the scoped governance suite:
    ```bash
    pnpm test -- --test-name-pattern "spec 153"
    ```
    All assertions green. Full suite still passes — the schema delta
    is additive (a new non-unique index), the WHERE clause change
    is a narrowing predicate (any row that rendered before now
    either still renders or returns 404, never a different row),
    and the date-filter helper is a refinement (any string the old
    regex would have accepted is still accepted IFF it parses to
    a valid calendar date).
