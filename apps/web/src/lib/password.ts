import bcrypt from "bcryptjs";

// Spec 167 — single source of truth for the bcrypt cost across apps/web.
//
// Pre-167 every route that hashed a secret hardcoded the literal `10`:
//   - apps/web/src/lib/password.ts          (user passwords)
//   - apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts (gate hash)
//   - apps/web/src/app/api/auth/forgot-password/route.ts      (reset token)
//   - apps/web/src/app/api/auth/reset-password/route.ts       (new password)
//   - packages/db/src/scripts/seed.ts                          (super_admin bootstrap)
//
// That's five literal `10`s that have to march in lockstep. Bumping the cost
// (e.g. to 12 once production hardware allows) without missing a call site is
// the kind of refactor that benefits enormously from a single exported const.
//
// `BCRYPT_COST` is the canonical value. seed.ts lives in `packages/db` and
// can't import from `apps/web`, so it carries an inline comment pointing at
// this file as the source of truth — the spec-167 governance test verifies
// the comment is present so a future cost bump in this file forces a paired
// edit in seed.ts (or the test fails and the contributor sees the drift).
export const BCRYPT_COST = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
