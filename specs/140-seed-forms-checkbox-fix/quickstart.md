# Quickstart 140 — seed-forms checkbox fix

Manual smoke (5 minutes), all on a fresh dev database:

1. Boot the stack: `pnpm dev` (web) + the docker-compose db /
   redis / minio. If the db already has the buggy plural rows in
   `feedback_forms`, truncate the table first so the new singular
   value gets inserted (`pnpm --filter @gml/db run db:reset`).
2. Run the orchestrator: `pnpm --filter @gml/db run seed:all`.
   Expect zero `WARN — dropping` messages in stdout — every form
   in every seed passes the canonical-kind guard.
3. Inspect the mentor baseline form row in psql:
   ```sql
   SELECT schema -> 'fields' -> 1 ->> 'kind' AS kind
   FROM feedback_forms
   WHERE kind = 'baseline' AND audience = 'mentor' AND version = '1';
   ```
   The `kind` column on the `expertise_areas` field should now
   read `checkbox` (singular), not `checkboxes`.

## Render-path verification

4. Sign in as a `mentor`. Navigate to the mentor baseline form
   page (the form-runner page that hosts the mentor baseline
   template — typically `/forms/<id>` after the cycle bootstrap).
5. Scroll to the `Expertise areas you bring to this pairing`
   question. Before this fix, you saw a single-line text input
   with the eight option strings inaccessible. After the fix,
   you see eight stacked rows, each with a checkbox on the left
   and the option label on the right, matching the visual style
   of every other checkbox group in the LMS.
6. Tick three of the eight options. The selection state visibly
   toggles (the row's border darkens to `var(--ink)` and the
   background shifts to `var(--paper-2)`).
7. Submit the form. In psql, inspect the
   `feedback_responses.responses` jsonb:
   ```sql
   SELECT responses -> 'expertise_areas' AS picks
   FROM feedback_responses
   ORDER BY created_at DESC
   LIMIT 1;
   ```
   The value is a JSON array of the three option strings you
   ticked, not the empty string or `null`. This is the round-trip
   that was silently broken before.

## Reload-on-error verification (warn-and-skip path)

8. Temporarily edit `seed_forms_mentor.ts` (locally; do not
   commit) and change one field's `kind` from a canonical value
   to a clearly bogus literal (e.g. `kind: "not_a_kind"` on the
   `bio` field of `MENTOR_BASELINE`).
9. Re-run `pnpm --filter @gml/db run seed:all`. Expect the
   mentor seed phase to log a single `[seed-forms-mentor] WARN
   — dropping form (kind=baseline, audience=mentor, version=1)`
   line, then continue with the remaining three mentor forms.
   The other three sibling seeds (mentee, observation, misc)
   run normally. The orchestrator exits 0.
10. Inspect `feedback_forms` for mentor baseline — it should be
    absent (the guard dropped it). The other three mentor forms
    (`progress_1`, `progress_2`, `final`) are present.
11. Revert the temporary edit.

## Sibling-seed guard verification

12. Repeat steps 8-11 against `seed_forms_mentee.ts` (drop a
    field's `type` to `"not_a_type"`), `seed_forms_observation.ts`
    (drop a field's `type` to `"not_a_type"`), and
    `seed_forms_misc.ts` (drop a field's `kind` to
    `"not_a_kind"`). Each warns-and-skips the offending row and
    the rest of the orchestrator runs cleanly.

## Test gate

13. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 140"
    ```
    All assertions green. Full suite still 1083/1083 (or +N for
    this spec's new assertions; this spec adds new tests but
    does not regress existing ones — the seed-emit layer is
    not exercised by any other governance test).
