# Quickstart 152 — Admin grid improvements

Two manual smoke checks, each ~3 minutes. Both run against `pnpm dev`
+ the docker-compose db.

## (A) Column-type aware filter dispatcher

1. Boot `pnpm dev` and sign in as a `programme_admin`.
2. Navigate to `/admin/data/course-outlines`. The grid renders with
   six columns: Name (string), Subject (uuid string), Grade (number),
   Term (number), Weeks (number), Status (enum).
3. Type `physics` into the **Name** filter and Apply. The URL becomes
   `?filter[name]=physics&page=1`. The grid narrows via
   `ilike(name, "%physics%")` — case-insensitive contains, matches
   "Physics — Grade 9".
4. Clear and type `9` into the **Grade** filter. URL becomes
   `?filter[grade]=9`. The grid narrows via `eq(grade, 9)` — exact
   match, NO substring confusion ("9" never matches "19" or "29").
5. Clear and type `in_progress` into the **Status** filter. URL becomes
   `?filter[status]=in_progress`. The grid narrows via
   `eq(status, "in_progress")` — the dispatcher confirms
   "in_progress" ∈ `["planned","in_progress","complete","archived"]`.
6. Regression check (pre-fix): with the old blanket-ilike code,
   step 4 would have done a substring text-match on the integer
   column. On Postgres that fails with
   `operator does not exist: integer ~~* unknown`, the route 500s,
   the user sees the Error Boundary. With the dispatcher in place
   the route serves a clean filtered grid.
7. Edge case — type `not_a_status` into **Status** and Apply. The
   URL still carries `?filter[status]=not_a_status` but the
   dispatcher rejects it (not in the enum's options). The grid
   shows the unfiltered list. In dev-mode the server console logs
   "[admin-grid] filter skipped — enum value 'not_a_status' not in [...]".
8. Spot-check the audit log via `/admin/audit?action=learners.view`
   (learners is the SM-9 PII-audited entity). Filter the learners
   grid by something nonsense like `?filter[active]=banana` — the
   audit row's metadata now carries
   `{ filters: {}, skippedFilters: { active: "banana" } }` so the
   user's intent is recorded even when the filter didn't reach the DB.

## (B) Forms version-bump race

9. Sign in as a `programme_admin` and open `/admin/forms`. Pick any
   form (the seeded ones from spec 104 are fine) and note its current
   version, e.g. "2".
10. Open two browser tabs and load the form's edit screen in each.
    In tab A change one field and click Save (PUT). The version bumps
    to "3" and the response carries `{ ok:true, version:"3" }`.
11. **Race scenario, pre-fix:** in tab B (which still has the stale
    version "2" in its closure) make a different edit and click Save.
    With the old code both tabs would have read "2", both computed
    "3", tab B would have overwritten tab A's "3" with its own "3"
    (or hit the unique-index violation, depending on kind/audience).
12. **Race scenario, post-fix:** with this spec landed, tab B's PUT
    enters the transaction, calls `SELECT … FOR UPDATE`, finds tab A's
    lock already released (tab A's tx committed), reads version "3",
    and computes "4". The response is `{ ok:true, version:"4" }`.
    No trampling, no unique-violation 500.
13. To force the actual concurrent window in dev, use two terminal
    shells and `curl --parallel` two PUTs at the same id:
    ```
    curl -X PUT http://localhost:3000/api/admin/forms/<id> \
      -H 'Cookie: <session>' -d '{"changeA":true}' &
    curl -X PUT http://localhost:3000/api/admin/forms/<id> \
      -H 'Cookie: <session>' -d '{"changeB":true}' &
    wait
    ```
    Both responses come back 200 with versions N+1 and N+2 (in
    whichever order the lock acquired). Pre-fix this would have
    been two 200s at N+1.
14. Check `/admin/audit?action=form.schema.update` — two rows,
    `prevVersion: "2" → nextVersion: "3"` and `"3" → "4"`. The
    audit captures the true commit sequence, not the wishful one.

## Test gate

15. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 152"
    ```
    All assertions green. Full suite still passes (1197 / 1197
    pre-spec; this spec adds new assertions but does not regress
    existing ones — the two edits are surgical and no current test
    reaches into the modified lines).
