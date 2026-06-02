# Spec 148 — Gate rotation INSERT + DELETE wrapped in db.transaction

**Status:** complete · **Date:** 2026-06-02 · **Phase:** Workflow Run 13 (audit-closure) · **Severity:** HIGH (race window on password rotation).

## Why

The Workflow Run 13 7-agent audit surfaced ~50 findings across the 139 shipped specs. Among the 9 CRITICAL + HIGH items closing in Run 13 is a transaction-boundary regression in the section-gate password rotation route. Spec 115 (`apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts`) shipped two sequential writes against the `@gml/db` client:

```ts
await db.insert(sectionGates).values({ ... });
const deleted = await db.delete(sectionGateGrants).where(...).returning(...);
```

These are two separate statements over two round-trips. Between them — typically <1ms, but the window is real — a parallel request hitting `POST /gate/[slug]` could:

1. SELECT the freshly-inserted `section_gates` row (because `getCurrentGate()` orders by `version DESC` and the INSERT already committed).
2. bcrypt-compare against the new hash with a leaked old-plaintext attempt and pass (false-positive, edge case).
3. Or, far more realistically: the attacker holds a valid grant on the OLD password, the INSERT lands, our verify code now treats the new hash as authoritative, but the attacker's old grant cookie is still attached to the user-session row and survives until the DELETE arrives. The window is small, but the SM-2 substrate-moat threat model explicitly assumes rotation is the containment mechanism for compromised credentials — any non-zero window in which a compromised credential's grant survives a rotation is a real regression.

The fix is structural: wrap both writes in `db.transaction(async (tx) => { ... })` so either both land (rotation effective, grants flushed in one atomic visibility step) or neither lands (caller retries on a known-good state). Drizzle's `transaction` opens a single Postgres BEGIN/COMMIT block — both statements take effect at the same transaction-snapshot boundary, eliminating the cross-statement race window entirely.

## What

### Edit: `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts`

The two writes between lines 124-141 are replaced with a single `db.transaction` call:

```ts
const deleted = await db.transaction(async (tx) => {
  await tx.insert(sectionGates).values({
    slug: gateSlug,
    passwordHash,
    version: nextVersion,
    rotatedAt: new Date(),
    rotatedByUserId: session.user.id,
  });
  return tx
    .delete(sectionGateGrants)
    .where(eq(sectionGateGrants.gateSlug, gateSlug))
    .returning({ id: sectionGateGrants.id });
});
```

Key invariants:

- Both `tx.insert` and `tx.delete` use the **same** `tx` instance. Mixing `db` and `tx` inside a transaction callback would defeat the atomicity guarantee (the `db` call would run on a separate connection outside the BEGIN block).
- The DELETE's `.returning({id})` is preserved inside the tx so the audit metadata still captures `grantsInvalidated`.
- The transaction callback returns the deleted-id array; the outer `await db.transaction(...)` unwraps it, so the existing audit `deleted.length` reference works unchanged.
- The `recordAudit(...)` call sits OUTSIDE the transaction. This is deliberate: auditing a *committed* rotation is what we want (so failed transactions don't leak a "rotated" audit row), and audit-write failure cannot trigger a rollback of the rotation itself (audit is best-effort `void`-discarded per SM-1).
- The leading SELECT-max-version stays outside the transaction. Wrapping it in would not help (we are not enforcing version monotonicity via a tx-level lock here; the surrounding `section_gates` row count per slug is single-digit and the unique-version invariant is upheld by the INSERT itself if the schema later adds a UNIQUE(slug, version)).

### No new dependencies

`db.transaction` is part of Drizzle's existing API (`@gml/db` re-exports the configured drizzle instance). No package additions, no schema migrations (the row shapes are unchanged), no new audit actions.

### Documentation

The route header gains a Spec-148 paragraph explaining the transaction wrapping and the race-window threat model. The inline comment at the INSERT/DELETE site is updated to reference spec 148 and the SM-2 containment goal.

## Acceptance

- `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts` imports `db` (unchanged) and wraps the INSERT + DELETE pair in `db.transaction(async (tx) => { ... })`.
- The inner block calls `tx.insert(sectionGates).values(...)` and `tx.delete(sectionGateGrants).where(...).returning(...)`.
- `recordAudit({action: "gate.password.rotated", ...})` is called AFTER the transaction `await` returns, not inside the callback.
- Governance test `tests/governance/test_148_gate_rotate_transaction.test.mjs` passes with 5+ assertions covering the transaction call, the tx-scoped INSERT, the tx-scoped DELETE, the post-tx audit position, and the spec-kit file presence.
- `pnpm build` clean; no new dependencies.
