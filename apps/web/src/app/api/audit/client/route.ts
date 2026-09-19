// Client-side audit beacon.
//
// AntiDownloadGuard sends a beacon here when it sees a save, print or
// print-screen attempt, and the UI tells the user "Screenshots are logged."
//
// THAT SENTENCE WAS FALSE. This route did not exist. `navigator.sendBeacon`
// fails silently by design, so every attempt produced a 404 nobody saw, and the
// product made a claim about surveillance it was not performing — to users, in
// a toast, as a deterrent. Either the endpoint exists or the claim comes out;
// a deterrent that is a bluff is worse than none, because it is a lie told to
// the people the system is meant to serve.
//
// ── WHY THIS IS A NARROW ENDPOINT ────────────────────────────────────────────
//
// It writes to an append-only forensic log, from the browser, on an action the
// server cannot verify. So it accepts an ENUM, not a message: the caller picks
// from three known actions and supplies nothing else that reaches the log
// unbounded. Everything identifying — who, when, from where — is taken
// server-side, where the client cannot influence it.

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The only actions this endpoint will record.
 *
 * An allow-list rather than a string, because the alternative is letting a
 * browser write arbitrary action names into the table every administrator
 * reads and every report groups by.
 */
const ALLOWED: ReadonlySet<string> = new Set([
  "anti_download.attempt.save",
  "anti_download.attempt.print",
  "anti_download.attempt.printscreen",
  "anti_download.devtools.detected",
]);

export async function POST(req: Request) {
  const session = await auth();
  // 204, not 401. This is a fire-and-forget beacon; there is nothing useful a
  // signed-out caller could do with an error, and returning one only tells an
  // unauthenticated prober that the endpoint is real.
  if (!session) return new NextResponse(null, { status: 204 });

  // A keyboard can produce these events far faster than a person can mean
  // them, and holding Ctrl+P would otherwise write a row per repeat into an
  // append-only table that cannot be pruned.
  try {
    const rl = await rateLimit({
      bucket: "client-audit",
      id: session.user.id,
      limit: 30,
      windowMs: 60_000,
    });
    if (!rl.ok) return new NextResponse(null, { status: 204 });
  } catch {
    // Fail closed: drop the beacon rather than write unthrottled.
    return new NextResponse(null, { status: 204 });
  }

  let body: { action?: unknown; metadata?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const action = String(body.action ?? "");
  if (!ALLOWED.has(action)) return new NextResponse(null, { status: 204 });

  // Only the page path is carried through, capped, and only when it is a
  // same-site absolute path. It is the one piece of client-supplied context
  // that makes the row useful — "someone tried to print" is far less
  // actionable than "someone tried to print THIS learner record".
  const meta = (body.metadata ?? {}) as Record<string, unknown>;
  const rawPath = typeof meta.path === "string" ? meta.path : "";
  const path =
    rawPath.startsWith("/") && !rawPath.startsWith("//") ? rawPath.slice(0, 200) : null;

  await recordAudit({
    action,
    entityType: "client",
    metadata: { path },
  });

  return new NextResponse(null, { status: 204 });
}
