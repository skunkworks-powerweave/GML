// Governance test for spec 102 — MinIO bucket initialization service.
// Structural checks against docker-compose.yml + cross-check vs. the BUCKETS constant
// in apps/web/src/lib/video/minio.ts so the init script stays in sync with the app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readText(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

/** Extract the `minio-init:` block from docker-compose.yml (top-level service, 2-space indent). */
function extractMinioInitBlock(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^  minio-init:\s*$/.test(l));
  assert.ok(start >= 0, "docker-compose.yml must declare a top-level `minio-init` service");
  // Walk until the next sibling service (another 2-space-indented `name:`) or EOF.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
    // Also stop at the top-level `volumes:` or `networks:` keys.
    if (/^[a-z]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("FR-001: docker-compose.yml declares a `minio-init` service", () => {
  const yaml = readText("docker-compose.yml");
  assert.match(yaml, /^  minio-init:\s*$/m, "service `minio-init` must be declared at 2-space indent");
});

test("FR-002: minio-init uses the official minio/mc image", () => {
  const block = extractMinioInitBlock(readText("docker-compose.yml"));
  assert.match(block, /image:\s*minio\/mc(:[\w.-]+)?/, "minio-init must use a minio/mc image tag");
});

test("FR-004: minio-init waits for minio to be healthy", () => {
  const block = extractMinioInitBlock(readText("docker-compose.yml"));
  assert.match(block, /depends_on:\s*\n\s+minio:\s*\n\s+condition:\s*service_healthy/m,
    "minio-init must declare depends_on.minio.condition: service_healthy");
});

test("FR-003: minio-init is a one-shot (restart: 'no')", () => {
  const block = extractMinioInitBlock(readText("docker-compose.yml"));
  // Compose YAML accepts unquoted no, "no", or 'no'. The string `no` alone risks YAML-boolean
  // coercion in some parsers, so we accept it in quoted or unquoted form here.
  assert.match(block, /restart:\s*["']?no["']?\s*$/m,
    "minio-init must set `restart: \"no\"` for one-shot semantics");
});

test("FR-005 + FR-006: entrypoint creates buckets via `mc mb` for every BUCKETS entry", () => {
  const block = extractMinioInitBlock(readText("docker-compose.yml"));
  // Must invoke `mc mb` (the bucket-creation command).
  assert.match(block, /mc mb /, "entrypoint must call `mc mb` to create buckets");

  // Cross-check against the source-of-truth BUCKETS constant.
  const minioLib = readText("apps/web/src/lib/video/minio.ts");
  const bucketLiterals = [...minioLib.matchAll(/"(gml-[a-z0-9-]+)"/g)].map((m) => m[1]);
  const uniqueBuckets = [...new Set(bucketLiterals)];
  assert.ok(uniqueBuckets.length >= 3,
    `expected ≥3 bucket literals in apps/web/src/lib/video/minio.ts, found ${uniqueBuckets.length}: ${uniqueBuckets.join(", ")}`);

  // At least 3 of the BUCKETS names must appear in the minio-init entrypoint block.
  let hits = 0;
  for (const name of uniqueBuckets) {
    if (block.includes(name)) hits++;
  }
  assert.ok(hits >= 3,
    `expected ≥3 BUCKETS names from apps/web/src/lib/video/minio.ts in the minio-init entrypoint, found ${hits} (${uniqueBuckets.join(", ")})`);
});

test("FR-010: `mc mb` invocations use --ignore-existing for idempotency", () => {
  const block = extractMinioInitBlock(readText("docker-compose.yml"));
  // Every `mc mb ...` line should carry `--ignore-existing` so re-runs don't fail.
  const mbLines = block.split(/[;\n]/).filter((l) => l.includes("mc mb "));
  assert.ok(mbLines.length >= 3, `expected ≥3 \`mc mb\` invocations, found ${mbLines.length}`);
  for (const line of mbLines) {
    assert.match(line, /--ignore-existing/, `\`mc mb\` must include --ignore-existing (line: ${line.trim()})`);
  }
});

test("FR-007 + FR-008: minio-init receives MinIO root creds and joins lms_net", () => {
  const block = extractMinioInitBlock(readText("docker-compose.yml"));
  assert.match(block, /MINIO_ROOT_USER/, "minio-init must receive MINIO_ROOT_USER env var");
  assert.match(block, /MINIO_ROOT_PASSWORD/, "minio-init must receive MINIO_ROOT_PASSWORD env var");
  assert.match(block, /^\s+- lms_net\s*$/m, "minio-init must be attached to lms_net so `minio:9000` resolves");
});

test("FR-009: untouched services still present (no collateral edits)", () => {
  const yaml = readText("docker-compose.yml");
  for (const svc of ["postgres", "redis", "minio", "tusd", "app", "worker", "caddy"]) {
    const re = new RegExp(`^  ${svc}:`, "m");
    assert.match(yaml, re, `pre-existing service ${svc} must remain declared`);
  }
});
