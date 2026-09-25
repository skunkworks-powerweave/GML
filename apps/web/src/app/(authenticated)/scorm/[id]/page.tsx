// /scorm/[id] -- launch a SCORM 1.2 package.
//
// The package runs in ./player.tsx's sandboxed iframe, loaded from the
// same-origin content route, against the runtime API the player installs.
// Who may open it is lib/scorm/store.ts's answer (the subject is taught in her
// place, the package is not withdrawn); anyone else gets the 404 page, not a
// 403 that would confirm the package exists.
//
// The learner's own record seeds the runtime, so a relaunch resumes: her
// suspend data and location, entry "resume" after a suspend, and the time
// already spent.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { users } from "@gml/db/schema";
import { auth } from "@/auth";
import { uuidOrNotFound } from "@/lib/ids";
import { cmiStudentName } from "@/lib/scorm/cmi";
import { launchState, packageForViewer } from "@/lib/scorm/store";
import { ScormPlayer } from "./player";

export const dynamic = "force-dynamic";

export default async function ScormLaunchPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const id = uuidOrNotFound((await params).id);
  const viewer = { id: session.user.id, role: session.user.role };

  const pkg = await packageForViewer(db, viewer, id);
  if (!pkg) notFound();
  const [state, [me]] = await Promise.all([
    launchState(db, viewer.id, pkg.id),
    db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, viewer.id)).limit(1),
  ]);

  // Each path segment encoded (a file may be "my lesson.html"), then the
  // manifest's own ?query / #fragment as the manifest wrote it.
  const src = `/api/scorm/content/${pkg.id}/${pkg.launchPath.split("/").map(encodeURIComponent).join("/")}${pkg.launchQuery}`;
  const backHref = `/rtt/subject/${pkg.rttSubjectId}`;

  return (
    <div>
      <header style={{ marginBottom: 12 }}>
        <Link href={backHref} className="btn btn-sm btn-ghost">
          ← {pkg.subjectName}
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: 0 }}>{pkg.title}</h1>
          {!pkg.active ? (
            // Only an administrator reaches a withdrawn package.
            <span className="chip chip-rust" title="Learners cannot open it until it is re-activated at Admin → SCORM">
              Withdrawn
            </span>
          ) : null}
        </div>
      </header>
      <ScormPlayer
        packageId={pkg.id}
        src={src}
        title={pkg.title}
        backHref={backHref}
        init={{
          ...state,
          studentId: viewer.id,
          studentName: cmiStudentName(me?.name ?? null, me?.email ?? null),
          launchData: pkg.launchData,
          masteryScore: pkg.masteryScore,
        }}
      />
    </div>
  );
}
