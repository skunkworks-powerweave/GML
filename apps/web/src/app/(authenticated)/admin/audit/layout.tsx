// Section-gate boundary for /admin/audit.
//
// Same shape as the /observation and /mentorship gate layouts, and for the same
// reason: the gate decision is a database lookup, so it cannot live in the
// proxy, and a layout covers every nested route without each page having to
// remember it.
//
// This one was missing entirely. nav.ts declares `gate: "admin"` on the audit
// item and renders a padlock beside it; the slug was in no prefix list and
// verifyGate rejected it outright, so the padlock promised a control that did
// not exist. The audit log is the append-only record of every mutation in the
// system, including who viewed what -- a role check alone is a thinner guard
// than the UI was claiming.
//
// NOTE for whoever adds a mutating action under this segment: assert the gate
// inside the action too. Next runs a Server Action to completion BEFORE it
// renders any layout, so this file does not cover writes.

import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertSectionGate } from "@/lib/gates";

export default async function AdminAuditGateLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const requested = (await headers()).get("x-pathname") ?? "/admin/audit";
  await assertSectionGate(session.user.id, "admin", requested);

  return <>{children}</>;
}
