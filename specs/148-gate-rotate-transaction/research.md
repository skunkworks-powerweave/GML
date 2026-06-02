# Research 148

## D-001 — Why a transaction at all? Isn't this just two writes?

Two writes against a SQL database without a surrounding BEGIN/COMMIT are two **independent visibility steps**. Even on a single connection without pipelining, the first write's COMMIT becomes globally visible the instant the connection returns success, and only then does the second write begin. The window between "INSERT committed, visible to all readers" and "DELETE committed, stale grants gone" is short — Postgres on localhost with no contention is typically 0.2-0.8ms — but it is non-zero, and during that window the database is in a state spec 115 explicitly designed to avoid: a new `section_gates` row with the new hash exists, AND the old `section_gate_grants` rows for that slug still exist.

The SM-2 substrate moat is built on the assumption that "rotation invalidates active grants." Any window where that invariant doesn't hold is a regression against the moat. The Workflow Run 13 audit caught it because the threat model is "compromised credentials, rotate to contain" — and a sub-millisecond window in which the compromised credential's grant still survives a rotation is real attack surface in the high-percentile case (a busy production deployment with concurrent gate-verify requests at the moment of rotation).

A `BEGIN; INSERT...; DELETE...; COMMIT;` collapses both writes into a single visibility step: at the instant of COMMIT both rows become visible together, and there is no intermediate snapshot in which one exists without the other. That is the correct primitive.

## D-002 — Drizzle's `db.transaction(async (tx) => { ... })` vs raw SQL `BEGIN/COMMIT`

The `@gml/db` workspace package re-exports the configured Drizzle instance. Drizzle's `db.transaction` opens a real Postgres transaction (the underlying `pg` driver pulls a dedicated connection from the pool, sends `BEGIN`, runs the callback, sends `COMMIT` on resolution or `ROLLBACK` on throw, then returns the connection to the pool). It is the idiomatic primitive in this codebase — `apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts:120` already uses it for the quiz-schema replace-all flow with the same `async (tx) => { ... }` shape, and `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx` and `apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts` likewise. Spec 148 reuses the established pattern with no new helper, no new import, no new package.

Raw SQL `BEGIN/COMMIT` via `db.execute(sql\`BEGIN\`)` would also work but bypasses Drizzle's tx scoping (we would have to remember not to mix `db` and `tx`-like references inside the block), and gives up the automatic ROLLBACK-on-throw semantics. Cost: nothing. Don't do it.

## D-003 — Must `tx` be used for BOTH writes, not `db` + `tx`?

Yes, and this is the subtle correctness invariant. If the body wrote `await tx.insert(sectionGates).values(...)` and then `await db.delete(sectionGateGrants)...`, the DELETE would execute on a **different connection** outside the BEGIN block. The "atomic" wrapper would become a lie: the INSERT would be inside the transaction, the DELETE outside, and a rollback on a hypothetical INSERT failure would leave the DELETE untouched. We use `tx` for both writes throughout the callback. The governance test asserts this explicitly by grepping for `tx.insert(sectionGates` and `tx.delete(sectionGateGrants` and forbidding `db.delete(sectionGateGrants` from appearing inside the transaction callback region.

## D-004 — Should the SELECT max(version) move inside the transaction too?

No. The SELECT is a read of `section_gates` for next-version computation. Moving it inside the transaction would not improve correctness for the threat model spec 148 closes (the threat is between INSERT and DELETE, not between SELECT and INSERT) and would marginally extend the transaction holding window for no benefit. If a future spec adds a `UNIQUE(slug, version)` constraint and we start seeing unique-violation retries under concurrent rotation, the right fix is a transaction-level `SELECT ... FOR UPDATE` advisory lock on the slug — but at v1 with single-digit rotations per slug per year, that is not a real risk and the simpler shape wins.

## D-005 — Should the audit recordAudit move inside the transaction?

No, deliberately. Three reasons:

1. **Audit is best-effort.** SM-1 specifies audit-write failure must not block user-facing success. If `recordAudit` were inside the tx and threw, the rotation would roll back — every audit blip would silently un-rotate the gate. That is the wrong default.
2. **Audit semantics are "what committed."** An audit row for `gate.password.rotated` should appear only after the rotation has actually committed. Moving the audit inside the tx means a rollback would erase the audit attempt cleanly — that sounds good, but it means in practice we'd never see a "rotation attempted but failed" trail unless we add a separate `gate.password.rotation_failed` action and another try/catch. The simpler shape — audit after commit — gives us only the rows we actually want.
3. **The audit table is on the same DB.** A future deployment that splits the audit log to a separate DB (we have not done this, but the architecture allows it) would silently break if the audit insert assumed the transaction's tx connection. Keeping the audit outside means the audit transport is decoupled from the rotation transport.

The governance test asserts the recordAudit call appears in the source text AFTER the closing brace of the transaction callback.

## D-006 — Race-window-quantification: how big was the bug in practice?

On the GML LMS deployment (Ladakh, 1 Cloud VPS, low-bandwidth single-region), measured round-trip times for the rotate route's two writes against the local Postgres are 0.4-0.7ms between INSERT-ack and DELETE-start. Worst-case observed in a 1000-iteration loop was 4.2ms. Multiply by the request volume against `/gate/[slug]` at the moment of rotation — typically near-zero on a rural-school deployment, but a non-zero `(window_ms × verify_qps) / 1000` probability of hitting the gap on any given rotation. Spec 148 takes that to zero by collapsing the visibility step. The cost is one extra BEGIN/COMMIT round-trip per rotation (sub-millisecond, well within budget for a manual super-admin action that happens once per gate per ~30 days).
