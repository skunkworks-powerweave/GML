// Store an uploaded SCORM package: validate it whole, write its files, then
// register it -- or leave nothing behind.
//
// ── WHO MAY CALL THIS ────────────────────────────────────────────────────────
//
// A super_admin, and nobody else (app/api/scorm/packages/route.ts). A
// package's script runs on this origin as whoever opens it: it has to, since
// a SCO reaches the runtime through window.parent.API, and the Supabase
// session cookie is readable by script by design (lib/supabase/cookies.ts).
// The iframe sandbox cannot separate the two (lib/scorm/sandbox.ts). So an
// upload is equivalent to running code as every learner and administrator
// who launches it, and a programme_admin -- who cannot otherwise become a
// super_admin (admin/users/actions.ts) -- must not be able to do it.
//
// ── ORDER ────────────────────────────────────────────────────────────────────
//
// 1. The subject must exist, and the archive must pass validateScormPackage
//    whole: nothing is written for a package that would be refused.
// 2. Files are written to Storage under `<new id>/<n>`, a few at a time.
// 3. Only then are the package row and its file registry inserted, in one
//    transaction. A Storage or database failure at 2 or 3 removes every
//    object this upload wrote, so a failed upload leaves no row and no bytes.

import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { rttSubjects } from "@gml/db/schema";
import { validateScormPackage, type ScormPackageError } from "./package";
import { insertPackage } from "./store";
import { putScormObject, removeScormObjects } from "./storage";

type Db = NodePgDatabase<Record<string, unknown>>;

/** Parallel Storage writes: packages are many small files, and one at a time is minutes over a WAN. */
const CONCURRENCY = 4;
const TITLE_MAX = 240;

export type IngestError = { code: ScormPackageError["code"] | "unknown_subject" | "storage_failed"; message: string; paths?: string[] };

export type IngestResult =
  | { ok: true; id: string; title: string; fileCount: number; totalBytes: number }
  | { ok: false; status: 422 | 502; error: IngestError };

export async function ingestPackage(
  db: Db,
  input: { bytes: Uint8Array; rttSubjectId: string; title: string | null; uploadedByUserId: string },
): Promise<IngestResult> {
  const [subject] = await db.select({ id: rttSubjects.id }).from(rttSubjects).where(eq(rttSubjects.id, input.rttSubjectId)).limit(1);
  if (!subject) return { ok: false, status: 422, error: { code: "unknown_subject", message: "That RTT subject does not exist." } };

  const checked = validateScormPackage(input.bytes);
  if (!checked.ok) return { ok: false, status: 422, error: checked.error };
  const pkg = checked.pkg;

  const id = randomUUID();
  const files = pkg.files.map((f, n) => ({ ...f, objectKey: `${id}/${n}` }));
  const attempted: string[] = [];
  const undo = () => removeScormObjects(attempted).catch(() => undefined);

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    attempted.push(...batch.map((f) => f.objectKey));
    // allSettled, not all: every write of the batch has finished before any
    // clean-up, so none lands after the objects were removed.
    const results = await Promise.allSettled(batch.map((f) => putScormObject(f.objectKey, f.read())));
    if (results.some((r) => r.status === "rejected")) {
      await undo();
      return {
        ok: false,
        status: 502,
        error: { code: "storage_failed", message: "The package could not be stored, and nothing was kept. Try the upload again." },
      };
    }
  }

  const title = (input.title?.trim() || pkg.title).slice(0, TITLE_MAX);
  try {
    await insertPackage(db, {
      id,
      rttSubjectId: subject.id,
      title,
      manifestIdentifier: pkg.identifier,
      launchPath: pkg.launchPath,
      launchQuery: pkg.launchQuery,
      masteryScore: pkg.masteryScore,
      launchData: pkg.launchData,
      uploadedByUserId: input.uploadedByUserId,
      totalBytes: pkg.totalBytes,
      files: files.map((f) => ({ path: f.path, objectKey: f.objectKey, sizeBytes: f.size })),
    });
  } catch (err) {
    await undo();
    throw err;
  }
  return { ok: true, id, title, fileCount: files.length, totalBytes: pkg.totalBytes };
}
