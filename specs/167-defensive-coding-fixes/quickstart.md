# Quickstart — spec 167 defensive-coding fixes

## Repro the FormRenderer guard

In a dev render, intentionally pass both `action` and `onSubmit`:

```tsx
<FormRenderer
  schema={schema}
  action={submitFormAction}
  onSubmit={async () => {}}
/>
```

The page should crash with the React error boundary surface and the
text "FormRenderer: pass either `action` (server) or `onSubmit`
(client), not both." Production builds (NEXT_PUBLIC_ENV / NODE_ENV =
production) accept the same code unchanged and silently pick `action`.

## Verify BCRYPT_COST plumbing

```bash
$ grep -r "BCRYPT_COST" apps/web/src
apps/web/src/lib/password.ts:export const BCRYPT_COST = 10;
apps/web/src/lib/password.ts:  return bcrypt.hash(plain, BCRYPT_COST);
apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts:import { BCRYPT_COST } from "@/lib/password";
apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts:  const passwordHash = await bcrypt.hash(plaintext, BCRYPT_COST);
apps/web/src/app/api/auth/forgot-password/route.ts:import { BCRYPT_COST } from "@/lib/password";
apps/web/src/app/api/auth/forgot-password/route.ts:  const tokenHash = await bcrypt.hash(plaintextToken, BCRYPT_COST);
apps/web/src/app/api/auth/reset-password/route.ts:import { hashPassword, BCRYPT_COST } from "@/lib/password";
apps/web/src/app/api/auth/reset-password/route.ts:    metadata: { tokenId: matched.id, bcryptCost: BCRYPT_COST },
```

Five imports/usages, all reachable from `lib/password.ts`. A future cost
bump only has to edit the one `export const BCRYPT_COST = 10;` line.

## Trigger the degraded-mode counter

In a test environment, stub `db.insert` to throw and trigger a covered
endpoint:

```ts
import { __resetAuditDegradedCountForTests, getAuditDegradedCount } from
  "@/lib/audit";

__resetAuditDegradedCountForTests();
// ... mock db.insert to reject ...
// ... call POST /api/admin/learners/export ...
assert.equal(getAuditDegradedCount(), 1);
```

The route still returns 200 with the CSV body — the audit miss is loud
but not blocking.

## Run the governance test

```bash
pnpm test -- tests/governance/test_167_defensive_coding_fixes.test.mjs
```

Expected: all assertions pass.

## Run the full suite

```bash
pnpm test
```

Expected: 1423 / 1423 tests pass, no regression from prior runs.
