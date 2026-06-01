// Governance test for spec 101 — docker-compose env completeness (Tier A2).
// Asserts the 3 deployment-blocker env vars (WHATSAPP_APP_SECRET, MEDIA_SIGN_SECRET, ACME_EMAIL)
// are present in docker-compose.yml using the strict-fail `${VAR:?msg}` form,
// AND are documented in .env.example for fresh-operator discoverability.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readText(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

test("FR-001: docker-compose.yml declares WHATSAPP_APP_SECRET with strict-fail form", () => {
  const yaml = readText("docker-compose.yml");
  // pattern: WHATSAPP_APP_SECRET: ${WHATSAPP_APP_SECRET:?<some non-empty message>}
  assert.match(
    yaml,
    /WHATSAPP_APP_SECRET:\s*\$\{WHATSAPP_APP_SECRET:\?[^}]+\}/,
    "WHATSAPP_APP_SECRET must use the ${VAR:?message} strict-fail form in docker-compose.yml",
  );
});

test("FR-002: docker-compose.yml declares MEDIA_SIGN_SECRET with strict-fail form", () => {
  const yaml = readText("docker-compose.yml");
  assert.match(
    yaml,
    /MEDIA_SIGN_SECRET:\s*\$\{MEDIA_SIGN_SECRET:\?[^}]+\}/,
    "MEDIA_SIGN_SECRET must use the ${VAR:?message} strict-fail form in docker-compose.yml",
  );
});

test("FR-003: docker-compose.yml declares ACME_EMAIL with strict-fail form", () => {
  const yaml = readText("docker-compose.yml");
  assert.match(
    yaml,
    /ACME_EMAIL:\s*\$\{ACME_EMAIL:\?[^}]+\}/,
    "ACME_EMAIL must use the ${VAR:?message} strict-fail form in docker-compose.yml",
  );
});

test("FR-004: strict-fail messages are descriptive (>= 20 chars) — operators must get a useful error", () => {
  const yaml = readText("docker-compose.yml");
  for (const key of ["WHATSAPP_APP_SECRET", "MEDIA_SIGN_SECRET", "ACME_EMAIL"]) {
    const re = new RegExp(`${key}:\\s*\\$\\{${key}:\\?([^}]+)\\}`);
    const m = yaml.match(re);
    assert.ok(m, `${key} strict-fail entry not found`);
    assert.ok(
      m[1].trim().length >= 20,
      `${key} strict-fail message must be descriptive (>=20 chars), got: "${m[1]}"`,
    );
  }
});

test("FR-005: .env.example contains WHATSAPP_APP_SECRET", () => {
  const env = readText(".env.example");
  assert.match(env, /^WHATSAPP_APP_SECRET=/m, ".env.example must declare WHATSAPP_APP_SECRET");
});

test("FR-006: .env.example contains MEDIA_SIGN_SECRET", () => {
  const env = readText(".env.example");
  assert.match(env, /^MEDIA_SIGN_SECRET=/m, ".env.example must declare MEDIA_SIGN_SECRET");
});

test("FR-007: .env.example contains ACME_EMAIL", () => {
  const env = readText(".env.example");
  assert.match(env, /^ACME_EMAIL=/m, ".env.example must declare ACME_EMAIL");
});

test("FR-009: WHATSAPP_APP_SECRET + MEDIA_SIGN_SECRET sit under the `app` service block", () => {
  const yaml = readText("docker-compose.yml");
  // app service starts at "^  app:" and ends at the next top-level service or section.
  const appBlockMatch = yaml.match(/^ {2}app:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|^volumes:|^networks:)/m);
  assert.ok(appBlockMatch, "could not isolate `app` service block in docker-compose.yml");
  const appBlock = appBlockMatch[1];
  assert.match(appBlock, /WHATSAPP_APP_SECRET:/, "WHATSAPP_APP_SECRET must live under the app service");
  assert.match(appBlock, /MEDIA_SIGN_SECRET:/, "MEDIA_SIGN_SECRET must live under the app service");
});

test("FR-009: ACME_EMAIL sits under the `caddy` service block", () => {
  const yaml = readText("docker-compose.yml");
  const caddyBlockMatch = yaml.match(/^ {2}caddy:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|^volumes:|^networks:)/m);
  assert.ok(caddyBlockMatch, "could not isolate `caddy` service block in docker-compose.yml");
  const caddyBlock = caddyBlockMatch[1];
  assert.match(caddyBlock, /ACME_EMAIL:/, "ACME_EMAIL must live under the caddy service");
});
