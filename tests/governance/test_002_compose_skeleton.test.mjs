// Governance test for spec 002 — docker-compose skeleton.
// Structural sanity (file shape, services declared, etc.) — runtime stack-up is verified manually.
//
// PARTLY INVERTED. The service-count, role-comment, volume and Caddy-route
// assertions below used to pin a NINE-service stack and now pin a four-service
// one (migrate, app, worker, caddy). The old assertions were not merely stale —
// the first of them REQUIRED THE THING THAT MADE THE STACK UNSTARTABLE:
//
//   `minio` was a mandatory service in this test, and MinIO have since
//   WITHDRAWN their public Docker images. Not the pinned tag — the entire
//   `minio/*` namespace answers "pull access denied ... repository does not
//   exist". Because `app` and `worker` both declared
//   `depends_on: minio: service_healthy`, nothing in the stack could start on
//   any machine, regardless of every other defect (docs/verification.md B9).
//   A governance test that demands `minio:` be declared is a test that fails
//   the day someone fixes the outage. That is the shape of a test pinning a
//   bug in place, and it is why these are inverted rather than deleted.
//
// `tusd`, `redis` and `postgres` went for their own reasons, each recorded in
// the compose file itself and re-asserted below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readText(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

/**
 * `#`-comment-stripped view of a compose / Caddyfile / shell source.
 *
 * Mandatory for every absence assertion in this file: docker-compose.yml now
 * carries a long header explaining what happened to the five removed services,
 * so a naive `assert.ok(!/minio/.test(yaml))` would fail on the very comment
 * that documents minio's removal.
 */
const code = (src) => src.replace(/(^|\s)#.*$/gm, "$1");

/** Top-level service keys, in declaration order. */
function serviceNames(yaml) {
  const body = code(yaml).split(/^services:\s*$/m)[1] ?? "";
  const stop = body.search(/^(volumes|networks|configs|secrets):/m);
  const block = stop === -1 ? body : body.slice(0, stop);
  return [...block.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1]);
}

const SURVIVING = ["migrate", "app", "worker", "caddy"];

// Each removed service, plus the phrase in which docker-compose.yml is required
// to record WHY it went. The reason has to survive in the file: the next person
// to wonder "shouldn't there be a database in here?" must find the answer at
// the point of the absence, not in a spec folder they do not know to open.
const REMOVED = {
  minio: /WITHDREW|pull access denied/i,
  "minio-init": /minio-init/,
  tusd: /TUSD_INTERNAL_URL|gml-media/,
  redis: /SKIP LOCKED/i,
  postgres: /Supabase IS the database/i,
};

test("FR-001: docker-compose.yml declares exactly the four surviving services", () => {
  const yaml = readText("docker-compose.yml");
  // Was: a presence check over seven names including tusd, postgres, redis and
  // minio. Now an EXACT set, so a reintroduced sidecar has to be argued for
  // rather than appearing quietly.
  assert.deepEqual(
    serviceNames(yaml).sort(),
    [...SURVIVING].sort(),
    "docker-compose.yml must declare exactly migrate, app, worker and caddy",
  );
});

test("FR-001: the five removed services are gone AND their removal is explained", () => {
  const yaml = readText("docker-compose.yml");
  const stripped = code(yaml);
  for (const [svc, reason] of Object.entries(REMOVED)) {
    assert.ok(
      !new RegExp(`(^|\\s)${svc}:`, "m").test(stripped),
      `${svc} must not be declared or depended on anywhere in docker-compose.yml`,
    );
    assert.match(
      yaml,
      reason,
      `docker-compose.yml must record WHY ${svc} was removed (expected ${reason})`,
    );
  }
});

test("FR-001: every surviving service has a role description in the file", () => {
  const yaml = readText("docker-compose.yml");
  // Was: `expected ≥7 '# role:' comments`. The `# role:` convention went with
  // the five services; what the assertion was really protecting — a reader can
  // tell what each container is FOR without running it — is re-pointed at the
  // roster block in the compose header, which names all four.
  for (const svc of SURVIVING) {
    assert.match(
      yaml,
      new RegExp(`^#\\s+${svc}\\s{2,}\\S`, "m"),
      `docker-compose.yml must describe the '${svc}' service in its header roster`,
    );
  }
});

test("FR-002: named volumes declared (no host bind mounts for hot data)", () => {
  const yaml = readText("docker-compose.yml");
  // Was: pgdata, miniodata, redisdata, caddy_data, caddy_config. The first
  // three were the local stores for the three services that no longer exist —
  // keeping the volume declarations would leave 100 GB of orphaned data on the
  // box with nothing able to read it.
  for (const vol of ["worker_scratch", "caddy_data", "caddy_config"]) {
    const re = new RegExp(`^  ${vol}:`, "m");
    assert.match(yaml, re, `named volume ${vol} must be declared`);
  }
  for (const vol of ["pgdata", "miniodata", "redisdata"]) {
    assert.ok(
      !new RegExp(`^  ${vol}:`, "m").test(code(yaml)),
      `volume ${vol} must be gone — the service that used it no longer exists`,
    );
  }
});

test("FR-002: worker scratch is a named volume, not tmpfs", () => {
  const yaml = readText("docker-compose.yml");
  // New assertion guarding a regression the old file shipped: worker scratch
  // was `tmpfs: /tmp size=2g`, which failed outright on any source larger than
  // ~1 GB (the source has to coexist with its own HLS output) and spent 2 GiB
  // of an 8 GiB box's RAM to do it.
  assert.match(yaml, /^ +- worker_scratch:\/tmp$/m, "worker must mount worker_scratch at /tmp");
  assert.ok(!/tmpfs:/.test(code(yaml)), "no service may put ffmpeg scratch on tmpfs");
});

test("FR-002: the only host bind mount is read-only config", () => {
  const yaml = readText("docker-compose.yml");
  // The original test title promised "no host bind mounts for hot data" but
  // never actually checked for one. It does now: a `./`-rooted mount is
  // allowed only if it is `:ro`.
  const binds = [...code(yaml).matchAll(/^ +- (\.\/[^\s]+)$/gm)].map((m) => m[1]);
  const writable = binds.filter((b) => !b.endsWith(":ro"));
  assert.deepEqual(writable, [], `host bind mounts must be read-only, found: ${writable.join(", ")}`);
});

test("FR-007 + FR-008: Dockerfiles exist", () => {
  assert.ok(existsSync(resolve(root, "docker/app.Dockerfile")));
  assert.ok(existsSync(resolve(root, "docker/worker.Dockerfile")));
});

test("FR-010: Caddyfile exists and routes the expected paths", () => {
  const caddy = readText("docker/Caddyfile");
  assert.match(caddy, /app:3000/, "Caddyfile must route to app:3000");
  // Was: `assert.match(caddy, /tusd:1080/)`. The tusd upload route is gone with
  // the service. It had never worked anyway: `handle_path /api/uploads/tus/*`
  // did not match the tus CREATE request (POST /api/uploads/tus, no trailing
  // segment), and `handle_path` stripped a prefix that tusd's own
  // `-base-path=/uploads/` expected. Uploads go browser-direct to Supabase
  // Storage, so there is nothing left to proxy. Comments stripped first — the
  // Caddyfile explains the removal in prose and would otherwise trip this.
  assert.ok(
    !/tusd/.test(code(caddy)),
    "Caddyfile must not route to tusd — uploads go browser-direct to Supabase Storage",
  );
});

test("FR-009: /api/health route exists and exports GET", () => {
  const route = readText("apps/web/src/app/api/health/route.ts");
  assert.match(route, /export\s+async\s+function\s+GET/, "must export async GET");
});

test("Next.js standalone output configured", () => {
  const cfg = readText("apps/web/next.config.ts");
  assert.match(cfg, /output:\s*['"]standalone['"]/, "next.config.ts must set output: 'standalone'");
});

test(".dockerignore is at the build-context root and covers heavy dirs", () => {
  // This assertion used to read "docker/.dockerignore" -- and so codified the
  // bug. Docker reads .dockerignore from the BUILD CONTEXT ROOT (both compose
  // services use `context: .`), never from the Dockerfile's directory. The file
  // therefore had no effect: the build context was ~735 MB and `COPY . .`
  // layered the host's node_modules over the image's Linux install. Asserting
  // the wrong path is what let that survive 171 specs.
  assert.ok(
    !existsSync(resolve(root, "docker/.dockerignore")),
    "docker/.dockerignore must NOT exist -- Docker does not read it there",
  );
  const ig = readText(".dockerignore");
  for (const p of ["node_modules", "\.next", "workspace", "\.git", "\.env"]) {
    assert.match(ig, new RegExp(p), `.dockerignore must include ${p}`);
  }
});
