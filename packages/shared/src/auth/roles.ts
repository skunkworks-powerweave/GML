// 5-role model used across proxy, server components, and DB enums.
// Keep in sync with packages/db/src/schema/enums.ts roleEnum.
//
// THERE IS NO HIERARCHY. This module previously exported a ROLE_RANK map and
// compared with `>=`, which made every `requireRole([...])` call a MINIMUM-RANK
// FLOOR rather than an allow-list -- the check silently degraded to its weakest
// listed role. Two concrete consequences:
//
//   * `observer` and `mentor` both ranked 2, so each satisfied the other's
//     checks. Any observer could call signOffCycleAction -- the terminal,
//     locking transition on an observation cycle they were the observer for.
//   * `teacher` ranked 1, so ANY list containing "teacher" admitted EVERY
//     authenticated user. `admin/entities/sessions.ts` has
//     `mutateRoles: ["teacher", ...]`, and because the proxy matcher covers no
//     /api/* path, that broken predicate was the only guard on
//     POST /api/admin/data/sessions/import -- bulk row insert, open to any
//     signed-in user.
//
// Roles are now exact set membership. A caller that wants several roles must
// list every one of them; nothing is implied.

export const ROLES = [
  "teacher",
  "observer",
  "mentor",
  "programme_admin",
  "super_admin",
] as const;

export type RoleName = (typeof ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

/** Narrowing type guard -- use before trusting a role read off a session/JWT. */
export function isRoleName(value: unknown): value is RoleName {
  return typeof value === "string" && ROLE_SET.has(value);
}

/**
 * EXACT match. `super_admin` does NOT imply `teacher`; `mentor` does NOT imply
 * `observer`. If you want several roles, list them all.
 */
export function hasRole(actual: RoleName | string | undefined, required: RoleName): boolean {
  return actual === required;
}

/** True if `actual` is exactly one of `required`. */
export function hasAnyRole(
  actual: RoleName | string | undefined,
  required: readonly RoleName[],
): boolean {
  return actual !== undefined && (required as readonly string[]).includes(actual);
}

/** The two roles that administer the platform. Spelled out at call sites that need both. */
export const ADMIN_ROLES = ["programme_admin", "super_admin"] as const satisfies readonly RoleName[];

/** Every role. Use where a surface really is open to all authenticated users. */
export const ALL_ROLES = ROLES;
