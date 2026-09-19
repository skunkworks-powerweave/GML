// Section-gate boundary for /mentorship.
//
// The gate decision lives HERE, not in the proxy. The proxy still checks the
// `gml-gate-mentorship` cookie, but only to redirect quickly without a database
// round-trip -- that cookie is an unsigned marker and was, until this layout
// existed, the ONLY thing standing between any authenticated user and this
// section (see lib/gates.ts assertSectionGate for the full account).
//
// A layout covers every nested route, so /mentorship/<id> inherits the check
// automatically rather than each page having to remember it.

import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertSectionGate } from "@/lib/gates";

export default async function MentorshipGateLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Return the user to the page they ASKED for after unlocking, not to the
  // section root. Following a link to a specific cycle, entering the password
  // and landing on the index instead -- with no indication of why -- reads as
  // the link having been wrong. x-pathname is set by proxy.ts, which runs on
  // every request; the "/mentorship" fallback covers the case where it is absent.
  const requested = (await headers()).get("x-pathname") ?? "/mentorship";
  await assertSectionGate(session.user.id, "mentorship", requested);

  return <>{children}</>;
}
