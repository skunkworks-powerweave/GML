// Route group layout — wraps every authenticated route with the appropriate
// shell (desktop sidebar or mobile bottom tabs) based on device detection.
// Routes outside this group (e.g. /login, /gate/[slug]) render without chrome.

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { getDeviceType } from "@/lib/device";
import { DesktopShell, MobileShell } from "@/components/shells";
import type { RoleName } from "@gml/shared/auth/roles";

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const device = await getDeviceType();
  const user = {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    role: (session.user.role ?? "teacher") as RoleName,
    image: session.user.image ?? null,
  };

  if (device === "mobile") {
    return <MobileShell user={user}>{children}</MobileShell>;
  }
  return <DesktopShell user={user}>{children}</DesktopShell>;
}
