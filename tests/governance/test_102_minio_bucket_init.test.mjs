// Governance test for spec 102 — bucket initialisation.
//
// REWRITTEN. Spec 102 added a `minio-init` compose service that shelled out to
// `mc mb` against a MinIO container. Two things killed that design:
//
//   1. MinIO WITHDREW THEIR PUBLIC DOCKER IMAGES. Not the pinned tag -- the
//      whole `minio/*` namespace. `minio/minio:latest` and `minio/mc:latest`
//      are both "pull access denied ... repository does not exist". Since `app`
//      and `worker` each declared `depends_on: minio: service_healthy`, NOTHING
//      in the stack could start, on any machine, regardless of every other
//      defect. See docs/verification.md (B9).
//
//   2. IT WAS ALREADY OUT OF SYNC. The init service created
//      gml-videos-original / gml-videos-hls / gml-posters / gml-pdfs, while
//      tusd was configured to write to `gml-media` and the PDF viewer read from
//      `gml-resources`. Neither of those two was ever created by anything, so
//      both paths 502'd in a way indistinguishable from storage being down.
//      Three sources of truth for "where do the files live", two of them wrong.
//
// Buckets are now rows in `storage.buckets`, created by
// _post/005_storage_buckets_and_policies.sql -- the same idempotent, ledgered
// lane as every other schema change, rather than a container that has to be
// remembered. What this file pins is that there is exactly ONE list of bucket
// names and the migration matches it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

const MIGRATION = "packages/db/src/migrations/_post/005_storage_buckets_and_policies.sql";
const BUCKETS_MODULE = "packages/shared/src/storage/buckets.ts";
const POST_DIR = "packages/db/src/migrations/_post";

/**
 * Every ledgered _post file that creates buckets, concatenated. 005 created
 * the first four; a later feature adds its own bucket in its own file (009,
 * SCORM) rather than editing a ledgered migration that has already run --
 * migrate.ts would never re-apply an edit. The invariant is unchanged: the
 * buckets the migrations create are exactly the ones @gml/shared names.
 */
function bucketSql() {
  return readdirSync(resolve(root, POST_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => read(`${POST_DIR}/${f}`))
    .filter((sql) => /INSERT INTO storage\.buckets/.test(sql))
    .join("\n");
}

/** The bucket ids the migration inserts. */
function migrationBuckets(sql) {
  return [...sql.matchAll(/\(\s*'([a-z-]+)',\s*'\1',\s*false,/g)].map((m) => m[1]);
}

/** The bucket names the shared constant declares. */
function declaredBuckets(ts) {
  const block = ts.slice(ts.indexOf("export const BUCKETS"), ts.indexOf("} as const;"));
  return [...block.matchAll(/:\s*"([a-z-]+)"/g)].map((m) => m[1]);
}

test("spec 102: buckets are created by a migration, not by a container", () => {
  assert.ok(existsSync(resolve(root, MIGRATION)), `${MIGRATION} must exist`);
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /INSERT INTO storage\.buckets/,
    "buckets must be inserted as rows so creation is idempotent and ledgered",
  );
  assert.match(
    sql,
    /ON CONFLICT \(id\) DO UPDATE/,
    "re-running the migration must reconcile bucket settings, not fail",
  );
});

test("spec 102: there is exactly one list of bucket names, and it matches", () => {
  const fromSql = migrationBuckets(bucketSql()).sort();
  const fromTs = declaredBuckets(read(BUCKETS_MODULE)).sort();
  assert.ok(fromSql.length >= 4, `migration must declare the buckets, found: ${fromSql.join(", ")}`);
  assert.deepEqual(
    fromSql,
    fromTs,
    "the migration and @gml/shared/storage/buckets must agree. Drift between the " +
      "two is precisely what produced `gml-media` and `gml-resources` -- bucket " +
      "names referenced by running code that nothing ever created",
  );
});

test("spec 102: every bucket is PRIVATE", () => {
  const sql = bucketSql();
  const publicRows = [...sql.matchAll(/\(\s*'[a-z-]+',\s*'[a-z-]+',\s*(true|false),/g)]
    .map((m) => m[1])
    .filter((v) => v === "true");
  assert.deepEqual(
    publicRows,
    [],
    "a public bucket serves every object to anyone holding the URL, with no " +
      "token and no expiry. These objects are classroom recordings of " +
      "identifiable children.",
  );
});

test("spec 102: every bucket has a server-side size cap", () => {
  const rows = [...bucketSql().matchAll(/\(\s*'([a-z-]+)',\s*'\1',\s*false,\s*(\d+)/g)];
  assert.ok(rows.length >= 4, "expected a size limit on each bucket");
  for (const [, name, limit] of rows) {
    assert.ok(
      Number(limit) > 0,
      `${name} must carry a file_size_limit — the client-side check is a courtesy ` +
        `the uploader can edit out of the DOM`,
    );
  }
});

test("spec 102: nothing references the buckets that never existed", () => {
  // `gml-media` (tusd's target) and `gml-resources` (the PDF viewer's) were
  // both read by running code and created by nothing.
  for (const rel of [
    "apps/web/src/app/(authenticated)/repo/resource/[id]/view/page.tsx",
    "packages/shared/src/storage/buckets.ts",
  ]) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(
      !/gml-resources|gml-media|gml-videos-/.test(src),
      `${rel} must not name a legacy MinIO bucket`,
    );
  }
});

test("spec 102: the storage RLS posture is declared alongside the buckets", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /\(storage\.foldername\(name\)\)\[1\] = \(SELECT auth\.uid\(\)\)::text/,
    "direct browser upload must be bound to the uploader's own prefix BY THE " +
      "DATABASE, so a forged object key is refused even if application code is bypassed",
  );
  assert.ok(
    !/FOR SELECT/.test(sql),
    "there must be no SELECT policy: reads go through short-lived signed URLs " +
      "minted after lib/authz.ts has decided the question, and a storage policy " +
      "cannot express 'the mentor assigned to this pairing'",
  );
});
