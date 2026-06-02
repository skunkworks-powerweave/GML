# Quickstart 148

## Manual smoke

1. Boot the stack: `pnpm --filter @gml/web dev` + Postgres up (`docker compose up -d db`).
2. As a `super_admin`, hit `POST /api/admin/gates/mentorship/rotate` from the `/admin/gates` page's Rotate button.
3. Open Postgres (`psql -h localhost -U gml gml`) and observe:
   - `SELECT slug, version, rotated_at FROM section_gates WHERE slug = 'mentorship' ORDER BY version DESC LIMIT 2;` → two rows (old + new), new row has version+1 and the just-now timestamp.
   - `SELECT count(*) FROM section_gate_grants WHERE gate_slug = 'mentorship';` → 0.
4. The pair of observations should be atomic — if you race the rotate with another browser tab unlocking the gate, the unlocking browser either:
   - lands BEFORE the BEGIN (gets a grant against the OLD hash, then gets DELETEd in the COMMIT — observable as "unlocked then immediately re-locked"), or
   - lands AFTER the COMMIT (verifies against the NEW hash, gets a fresh grant).
   - There is no in-between state where a new-hash grant survives the rotation.

## Failure injection

To exercise the rollback path, temporarily change the DELETE's WHERE clause to a no-op `eq(sectionGateGrants.id, "force-failure")` and force a throw between INSERT and DELETE (e.g. add `throw new Error("test rollback")` after the INSERT inside the transaction callback). The expectation:

- `section_gates` should NOT show the new row (rolled back).
- `section_gate_grants` should be unchanged.
- The route returns 500 (uncaught throw bubbles to Next.js's error boundary).
- `audit_log` should NOT have a `gate.password.rotated` row for the failed attempt (the audit fires after the await, which never returned).

Revert the test injection before committing.

## Governance run

```
pnpm --filter @gml/web test:governance -- test_148_gate_rotate_transaction
```

Expect 5+ green assertions: file exists, db.transaction wrapper present, tx-scoped INSERT, tx-scoped DELETE, post-tx audit position, spec-kit file presence.
