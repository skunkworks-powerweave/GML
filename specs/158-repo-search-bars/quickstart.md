# Quickstart 158 — Repo name-search bars

Seven manual smoke checks, ~30 seconds each. No exotic setup — boot
the dev stack and sign in as any role that can read the repository.

## (A) Schools

1. Navigate to `/repo/schools`. The filter card now has a "Search
   name…" input next to the district tabs.
2. Type `chu` and click Search. The URL becomes `/repo/schools?q=chu`
   and the table narrows to schools whose names contain "chu"
   (case-insensitive).
3. Click the Leh district tab. The URL becomes `/repo/schools?district=
   leh&q=chu` — both filters now in flight; the search survives.
4. Click Clear. The URL becomes `/repo/schools?district=leh` — the
   search dropped, the district filter stays.

## (B) Teachers

5. Navigate to `/repo/teachers`. The filter form now has a Name input
   as its first field, before School and Phase.
6. Type a partial first name and click Apply. The URL becomes
   `/repo/teachers?q=<name>&school=&phase=` (form submits all
   three).
7. Pick a school from the School dropdown. Click Apply. URL becomes
   `/repo/teachers?q=<name>&school=<id>` — both filters combined.
8. Click Clear. URL becomes `/repo/teachers` — all filters dropped.

## (C) Mentors

9. Navigate to `/repo/mentors`. A new filter card sits at the top of
   the page body (the page had none before).
10. Type a partial mentor name and click Search. URL becomes
    `/repo/mentors?q=<name>`. Table narrows.
11. Click Clear. URL returns to `/repo/mentors`.

## (D) Subjects

12. Navigate to `/repo/subjects`. The filter form has a Name input
    as its first field.
13. Type "math" and click Apply. URL becomes `/repo/subjects?q=math&
    grade=`. Subjects matching "math" appear.
14. Pick "Grade 5" from the dropdown. Click Apply. URL combines.
15. Click Clear. All filters drop.

## (E) Sessions

16. Navigate to `/repo/sessions`. The filter form has a "Search
    topic…" input alongside the existing subject/from/to fields.
17. Type a partial topic keyword. Click Apply. URL gains `&q=<term>`.
    Sessions narrow on the topic column (not name — sessions don't
    have one).
18. Click a status tab (e.g. Planned). URL is `/repo/sessions?status=
    planned&q=<term>` — the search survives the status tab.
19. Click Clear. The `q` drops, status stays.

## (F) Resources

20. Navigate to `/repo/resources`. A new search card sits above the
    existing kind-pill row.
21. Type a partial document name. Click Search. URL becomes
    `/repo/resources?q=<term>`.
22. Click the "Policy" kind pill. URL becomes `/repo/resources?kind=
    Policy&q=<term>` — search survives the kind narrowing.
23. Click Clear. Search drops, kind stays.

## (G) Outlines

24. Navigate to `/repo/outlines`. The filter form has a Name input
    as its first field.
25. Type a partial outline name. Click Apply. URL combines with any
    grade/term/status filters.
26. Click Clear. All four filters drop.

## (H) Edge cases

27. Type 500 characters into any search input. The input enforces
    `maxLength={200}` so only the first 200 are accepted. (Or paste
    a giant blob — same effect.)
28. Type `%` or `_` literally. The ILIKE escape ensures the wildcard
    interpretation doesn't kick in — only literal `%` / `_` would
    match. (None of the seeded names contain those characters, so
    in practice the table will be empty — that's correct.)
29. Type all whitespace. Click Search. The URL gains `q=%20%20` but
    the WHERE clause drops the filter (the trim() in qFilter).
    Behaves identically to no search.

## Test gate

30. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 158"
    ```
    All assertions green. Full suite still passes (1295 / 1295
    pre-spec).
