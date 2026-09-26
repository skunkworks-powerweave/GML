// GET /api/scorm/content/<package id>/<path...> -- one file of a SCORM
// package, served from the application's OWN origin.
//
// WHY SAME-ORIGIN. A SCO finds the LMS runtime by walking window.parent for
// `API` (the player page defines it, app/(authenticated)/scorm/[id]). That is
// a same-origin DOM access; content served from a Supabase URL could not make
// it, and would silently run untracked.
//
// WHY ITS OWN POLICY. SCORM content is built on inline <script> and often
// eval(). The application's nonce policy would block both, so this route --
// and only this route -- sends buildScormContentCsp, and proxy.ts's matcher
// excludes it so the nonce policy is not also sent (two policies are both
// enforced). Because the proxy does not run here, the baseline headers it
// would have set are set below.
//
// WHAT IS SERVED. Only a path the upload registered (scorm_package_files),
// looked up exactly; only for a viewer who may launch the package
// (lib/scorm/store.ts); only with the Content-Type the allowlist gives its
// extension (lib/scorm/files.ts), never Storage's or a sniffed one. A miss of
// any kind is a 404, so a package outside the viewer's place is not revealed
// to exist.

import { NextResponse } from "next/server";
import { db } from "@gml/db";
import { auth } from "@/auth";
import { buildScormContentCsp } from "@/lib/csp";
import { scormContentType } from "@/lib/scorm/files";
import { servableFile } from "@/lib/scorm/store";
import { openScormObject, singleRange } from "@/lib/scorm/storage";

export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  // A service worker registered from package content would outlive the
  // package and intercept this path on every later launch, for every
  // package. Browsers mark the fetch of a service-worker script with this
  // header (Service Workers spec, "Service-Worker: script").
  if (req.headers.get("service-worker")) {
    return NextResponse.json({ error: "service_workers_not_allowed" }, { status: 403 });
  }

  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id, path } = await params;
  const rel = path.join("/");
  const contentType = scormContentType(rel);
  if (!contentType) return notFound();

  const file = await servableFile(db, { id: session.user.id, role: session.user.role }, id, rel);
  if (!file) return notFound();

  const upstream = await openScormObject(file.objectKey, singleRange(req.headers.get("range")));
  if (!upstream) return NextResponse.json({ error: "object_unavailable" }, { status: 502 });

  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Security-Policy": buildScormContentCsp(),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    "Cross-Origin-Resource-Policy": "same-origin",
    // A package's files never change under its id (a new upload is a new
    // package), and on a 2G link a relaunch should not refetch them. Private:
    // the response is per-viewer, so no shared cache may keep it.
    "Cache-Control": "private, max-age=86400",
    "Accept-Ranges": "bytes",
  });
  for (const name of ["content-length", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
