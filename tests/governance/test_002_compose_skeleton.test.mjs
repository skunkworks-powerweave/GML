// Governance test for spec 002 — docker-compose skeleton.
// Structural sanity (file shape, services declared, etc.) — runtime stack-up is verified manually.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readText(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

test("FR-001: docker-compose.yml declares all 7 services", () => {
  const yaml = readText("docker-compose.yml");
  for (const svc of ["caddy", "app", "worker", "tusd", "postgres", "redis", "minio"]) {
    // require a top-level service entry: 2-space indent + name + colon
    const re = new RegExp(`^  ${svc}:`, "m");
    assert.match(yaml, re, `service ${svc} must be declared`);
  }
});

test("FR-001: every service has a leading role comment", () => {
  const yaml = readText("docker-compose.yml");
  // Each service block should have a `# role: ...` comment above or just inside the block.
  // Soft check: at least 7 comment lines starting with "# role:" in the file.
  const comments = yaml.match(/^\s*# role:/gm) ?? [];
  assert.ok(comments.length >= 7, `expected ≥7 '# role:' comments, found ${comments.length}`);
});

test("FR-002: named volumes declared (no host bind mounts for hot data)", () => {
  const yaml = readText("docker-compose.yml");
  for (const vol of ["pgdata", "miniodata", "caddy_data", "caddy_config", "redisdata"]) {
    const re = new RegExp(`^  ${vol}:`, "m");
    assert.match(yaml, re, `named volume ${vol} must be declared`);
  }
});

test("FR-007 + FR-008: Dockerfiles exist", () => {
  assert.ok(existsSync(resolve(root, "docker/app.Dockerfile")));
  assert.ok(existsSync(resolve(root, "docker/worker.Dockerfile")));
});

test("FR-010: Caddyfile exists and routes the expected paths", () => {
  const caddy = readText("docker/Caddyfile");
  assert.match(caddy, /app:3000/, "Caddyfile must route to app:3000");
  assert.match(caddy, /tusd:1080/, "Caddyfile must route /uploads to tusd:1080");
});

test("FR-009: /api/health route exists and exports GET", () => {
  const route = readText("apps/web/src/app/api/health/route.ts");
  assert.match(route, /export\s+async\s+function\s+GET/, "must export async GET");
});

test("Next.js standalone output configured", () => {
  const cfg = readText("apps/web/next.config.ts");
  assert.match(cfg, /output:\s*['"]standalone['"]/, "next.config.ts must set output: 'standalone'");
});

test(".dockerignore covers heavy dirs", () => {
  const ig = readText("docker/.dockerignore");
  for (const p of ["node_modules", ".next", "workspace", ".git"]) {
    assert.match(ig, new RegExp(p), `.dockerignore must include ${p}`);
  }
});
