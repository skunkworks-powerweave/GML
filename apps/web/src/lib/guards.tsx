// Server-side guards. Use inside server components / server actions to assert
// the current user has the required role; throws redirect or notFound otherwise.

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { hasAnyRole, type RoleName } from "@gml/shared/auth/roles";

export async function getSessionOrRedirect(nextPath = "/") {
  const session = await auth();
  if (!session?.user) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  return session;
}

export async function requireRole(roles: RoleName[]) {
  const session = await auth();
  if (!session?.user) {
    redirect(`/login`);
  }
  if (!hasAnyRole(session.user.role, roles)) {
    redirect("/forbidden");
  }
  return session;
}

export async function Guarded({
  roles,
  children,
  fallback = null,
}: {
  roles: RoleName[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) return fallback;
  if (!hasAnyRole(session.user.role, roles)) return fallback;
  return <>{children}</>;
}
