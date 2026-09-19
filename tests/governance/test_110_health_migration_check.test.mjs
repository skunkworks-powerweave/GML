import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const HEALTH_LIB = "apps/web/src/lib/health.ts";
const HEALTH_ROUTE = "apps/web/src/app/api/health/route.ts";
const SPEC_DIR = "specs/110-health-migration-check";
const JOURNAL = "packages/db/src/migrations/meta/_journal.json";

test("spec 110: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 110: apps/web/src/lib/health.ts exports pingMigrations", () => {
  const src = read(HEALTH_LIB);
  assert.match(
    src,
    /export\s+async\s+function\s+pingMigrations\b/,
    "health.ts must declare 'export async function pingMigrations(' so the route can import it",
  );
});

test("spec 110: pingMigrations references _journal.json (or computes an expected migration count)", () => {
  const src = read(HEALTH_LIB);
  // The function must source the expected count from the Drizzle journal file —
  // we accept either an explicit filename mention or a meta/journal path fragment.
  assert.match(
    src,
    /_journal\.json|migrations\/meta\/_journal/,
    "pingMigrations must read the Drizzle journal file for the expected migration count",
  );
});

test("spec 110: pingMigrations queries the __drizzle_migrations table", () => {
  const src = read(HEALTH_LIB);
  // The table lives in the `drizzle` schema; either the bare name or the qualified
  // form is acceptable as long as the query targets it.
  assert.match(
    src,
    /__drizzle_migrations/,
    "pingMigrations must query the __drizzle_migrations table for the applied count",
  );
});

test("spec 110: pingMigrations handles table-not-found with a recognisable sentinel", () => {
  const src = read(HEALTH_LIB);
  // The spec mandates a sentinel error string the operator can grep on.
  assert.match(
    src,
    /drizzle migrations table not found/,
    "pingMigrations must surface the 'drizzle migrations table not found' sentinel when the table is absent",
  );
});

test("spec 110: pingMigrations is wrapped in try/catch (defensive against pg / fs failures)", () => {
  const src = read(HEALTH_LIB);
  // Grab the function body and assert it contains a catch clause.
  const match = src.match(/export\s+async\s+function\s+pingMigrations[\s\S]*?\n\}\s*$/m);
  assert.ok(match, "pingMigrations function body must be found");
  assert.match(match[0], /catch\s*\(/, "pingMigrations must contain at least one catch clause");
});

test("spec 110: /api/health route includes pingMigrations in its Promise.all", () => {
  const src = read(HEALTH_ROUTE);
  // The route must import pingMigrations from @/lib/health.
  assert.match(
    src,
    /import\s*\{[^}]*\bpingMigrations\b[^}]*\}\s*from\s*["']@\/lib\/health["']/,
    "route.ts must import pingMigrations from @/lib/health",
  );
  // And the function must be invoked inside a Promise.all.
  assert.match(
    src,
    /Promise\.all\s*\(\s*\[[\s\S]*?pingMigrations\s*\([\s\S]*?\]\s*\)/,
    "route.ts must invoke pingMigrations() inside Promise.all alongside the other pings",
  );
});

test("spec 110: /api/health response body includes a 'migrations' field", () => {
  const src = read(HEALTH_ROUTE);
  // Top-level migrations key in the JSON response.
  assert.match(
    src,
    /migrations:\s*migrations\.ok/,
    "route.ts must include `migrations: migrations.ok` in the response JSON",
  );
  // And the full migrations result must appear under details (for diagnostics).
  assert.match(
    src,
    /details:\s*\{[^}]*\bmigrations\b/,
    "route.ts must include the full migrations object in details for diagnostics",
  );
});

test("spec 110: overall ok flag depends on migrations.ok in the && chain", () => {
  const src = read(HEALTH_ROUTE);
  // UNCHANGED, and the reason spec 110 existed: the stub `const ok = true`
  // must stay gone, so an unmigrated stack cannot report itself healthy.
  assert.match(
    src,
    /const\s+ok\s*=\s*[^;]*\bmigrations\.ok\b/,
    "route.ts must derive `ok` from a conjunction that includes migrations.ok (no longer the `const ok = true` stub)",
  );
  assert.match(src, /\bdb\.ok\b/);

  // INVERTED. This used to require `redis.ok` and `minio.ok` as conjuncts.
  // Both services are gone -- Redis to a Postgres-backed queue and rate
  // limiter, MinIO to Supabase Storage -- and they are replaced by a single
  // `storage.ok`.
  //
  // Leaving a stale conjunct behind would be worse than a cosmetic wart. `ok`
  // is an AND over every probe, and a probe for a service that does not exist
  // returns false forever: /api/health would sit at 503 permanently, which
  // takes the container HEALTHCHECK and scripts/deploy.sh's `curl -fsS`
  // readiness wait down with it. A health check that cannot pass is an outage
  // the same way a health check that cannot fail is a lie -- and spec 110 was
  // written to fix the second of those.
  assert.match(
    src,
    /const\s+ok\s*=\s*[^;]*\bstorage\.ok\b/,
    "route.ts must AND in storage.ok -- the single probe that replaced redis + minio",
  );
  const body = read(HEALTH_ROUTE)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/\bredis\b/i.test(body),
    "no redis probe may remain in the health route -- it would pin /api/health at 503",
  );
  assert.ok(
    !/\bminio\b/i.test(body),
    "no minio probe may remain in the health route -- it would pin /api/health at 503",
  );
});

test("spec 110: health.ts ships pingStorage and no probe for a deleted service", () => {
  // The library side of the same inversion. pingRedis and pingMinio were
  // exported here and consumed by the route; both are gone. Pinned separately
  // from the route so that re-adding an unused probe is caught even before
  // something wires it into the AND.
  const src = read(HEALTH_LIB);
  assert.match(
    src,
    /export\s+async\s+function\s+pingStorage\b/,
    "health.ts must export pingStorage",
  );
  const body = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const gone of ["pingRedis", "pingMinio"]) {
    assert.ok(
      !new RegExp(`\\b${gone}\\b`).test(body),
      `health.ts must not declare ${gone} -- the service it probed no longer exists`,
    );
  }
});

test("spec 110: _journal.json fixture is present (test sanity)", () => {
  // The whole feature is meaningless without the journal — this guards against
  // the build dropping it accidentally.
  assert.ok(
    existsSync(resolve(root, JOURNAL)),
    "packages/db/src/migrations/meta/_journal.json must exist for pingMigrations to source the expected count",
  );
  const journal = JSON.parse(read(JOURNAL));
  assert.ok(
    Array.isArray(journal.entries) && journal.entries.length > 0,
    "journal must contain a non-empty entries array",
  );
});

test("spec 110: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});

test("spec 110: no stub / TODO / FIXME markers in pingMigrations", () => {
  const src = read(HEALTH_LIB);
  const match = src.match(/export\s+async\s+function\s+pingMigrations[\s\S]*?\n\}\s*$/m);
  assert.ok(match, "pingMigrations function body must be found");
  const body = match[0];
  assert.ok(!/\bTODO\b/i.test(body), "pingMigrations must not contain TODO markers");
  assert.ok(!/\bFIXME\b/i.test(body), "pingMigrations must not contain FIXME markers");
  assert.ok(!/placeholder/i.test(body), "pingMigrations must not contain 'placeholder' literals");
});
