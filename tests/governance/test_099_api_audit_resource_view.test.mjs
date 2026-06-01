import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE_PATH = "apps/web/src/app/api/audit/resource-view/route.ts";
const SPEC_DIR = "specs/099-api-audit-resource-view";

test("spec 099: route file exists at apps/web/src/app/api/audit/resource-view/route.ts", () => {
  assert.ok(existsSync(resolve(root, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
});

test("spec 099: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 099: route exports a POST handler", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /export\s+async\s+function\s+POST\s*\(/);
});

test("spec 099: route exports an explicit GET handler that returns 405", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /export\s+async\s+function\s+GET\s*\(/);
  assert.match(src, /status:\s*405/);
  // Allow header is part of the contract for any non-HTML probe.
  assert.match(src, /Allow["']?\s*:\s*["']POST["']/);
});

test("spec 099: route gates on auth() from @/auth and 401s anon callers", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+["']@\/auth["']/);
  assert.match(src, /await\s+auth\(\)/);
  // The 401 branch must check session?.user?.id (matches the repo convention).
  assert.match(src, /session\?\.user\?\.id/);
  assert.match(src, /status:\s*401/);
});

test("spec 099: route validates the body with zod", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+["']zod["']/);
  // Body schema must use safeParse so validation failures don't throw.
  assert.match(src, /safeParse\s*\(/);
  // resourceId must be uuid-validated per the spec contract.
  assert.match(src, /uuid\(\)/);
  // 400 on validation failure.
  assert.match(src, /status:\s*400/);
  assert.match(src, /validation_failed/);
});

test("spec 099: route calls recordAudit with the agreed action + entityType", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+["']@\/lib\/audit["']/);
  assert.match(src, /recordAudit\s*\(/);
  // Action string is load-bearing for SM-9 dashboards.
  assert.match(src, /action:\s*["']resource\.view\.client_ping["']/);
  assert.match(src, /entityType:\s*["']resource["']/);
  // beacon flag in metadata distinguishes this from the primary audit row.
  assert.match(src, /beacon:\s*true/);
});

test("spec 099: route returns 204 No Content on success (sendBeacon-friendly)", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /status:\s*204/);
  // 204 means no body — make sure we didn't accidentally json-respond with 204.
  assert.ok(
    !/NextResponse\.json\([^)]*204/.test(src),
    "204 must not carry a JSON body — use new NextResponse(null, { status: 204 })",
  );
});

test("spec 099: route MUST NOT 404 on missing/unknown resourceId (fire-and-forget)", () => {
  const src = read(ROUTE_PATH);
  // Never look the resource up — the whole point is non-blocking telemetry.
  assert.ok(
    !/from\(resources\)/.test(src),
    "route must not select from resources — beacon must accept unknown ids",
  );
  assert.ok(
    !/notFound\(\)/.test(src),
    "route must not call notFound() — beacon never 404s",
  );
  assert.ok(
    !/status:\s*404/.test(src),
    "route must not return 404 for any reason",
  );
});

test("spec 099: no new dependencies introduced (zod is pre-existing)", () => {
  const pkg = JSON.parse(read("apps/web/package.json"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  // zod must already be present (spec 071 introduced it), and we don't add anything new.
  assert.ok("zod" in deps, "zod must already be a dep of apps/web");
  // Guard against accidentally pulling in beacon/transport libs.
  for (const banned of ["beacon", "ua-parser-js", "request-ip"]) {
    assert.ok(
      !(banned in deps),
      `${banned} must not appear in apps/web/package.json (no new deps)`,
    );
  }
});

test("spec 099: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});

test("spec 099: route has no stub / TODO / placeholder markers", () => {
  const src = read(ROUTE_PATH);
  assert.ok(!/\bTODO\b/i.test(src), "route must not contain TODO markers");
  assert.ok(!/\bFIXME\b/i.test(src), "route must not contain FIXME markers");
  assert.ok(!/placeholder/i.test(src), "route must not contain 'placeholder' literals");
});
