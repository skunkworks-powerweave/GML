// 5-role hierarchy used across middleware, server components, and DB enums.
// Keep in sync with packages/db/src/schema/enums.ts roleEnum.

export const ROLES = [
  "teacher",
  "observer",
  "mentor",
  "programme_admin",
  "super_admin",
] as const;

export type RoleName = (typeof ROLES)[number];

export const ROLE_RANK: Record<RoleName, number> = {
  teacher: 1,
  observer: 2,
  mentor: 2,
  programme_admin: 3,
  super_admin: 4,
};

/** True if `actual` is at least as privileged as `required`. */
export function hasRole(actual: RoleName | string | undefined, required: RoleName): boolean {
  if (!actual) return false;
  const a = ROLE_RANK[actual as RoleName];
  if (!a) return false;
  return a >= ROLE_RANK[required];
}

/** True if `actual` satisfies any of the required roles. */
export function hasAnyRole(actual: RoleName | string | undefined, required: RoleName[]): boolean {
  return required.some((r) => hasRole(actual, r));
}
