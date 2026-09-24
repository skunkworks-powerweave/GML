// The Supabase pooler CA must reach the containers that open database
// connections, or verifying the pooler is impossible however .env is set.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// packages/db/src/client.ts verifies the pooler only when SUPABASE_CA_CERT
// (a path or a PEM) is set IN THE CONTAINER. docker-compose.yml forwarded it to
// no service and mounted no CA file, and .env.example told the operator to
// name a HOST path (/etc/gml/supabase-ca.crt) that exists in no container.
// Meanwhile preflight.sh printed "the pooler certificate will be verified"
// from the .env value. Every container ran encrypted-but-unauthenticated
// while the operator was told otherwise.
//
// ── THE FIX THIS PINS ────────────────────────────────────────────────────────
//
// One fixed file, docker/supabase-ca.crt, committed EMPTY, bind-mounted
// read-only at /etc/gml/supabase-ca.crt in migrate, app and worker, with
// SUPABASE_CA_CERT pointing there. The mount always resolves (a `${VAR}:...`
// mount expands to `::ro` when the variable is unset and breaks
// `docker compose config`); an empty file reads as "" and client.ts treats
// that as "no CA" — today's warn-and-continue, with no new failure mode.
// preflight.sh checks that same file (tests/scripts/preflight-sh.test.mjs).
//
// A text-level test is the right tier for this one: the defect IS the compose
// text. `docker compose config` in CI's images job proves the file parses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const MOUNT = "./docker/supabase-ca.crt:/etc/gml/supabase-ca.crt:ro";
const IN_CONTAINER = "/etc/gml/supabase-ca.crt";

/** The text of one top-level service block. */
function serviceBlock(yaml, name) {
  const m = yaml.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9_-]*:\\n|\\n[a-z])`));
  assert.ok(m, `could not isolate the ${name} service block`);
  return m[1].split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
}

test("the CA placeholder exists, so the bind mount always resolves", () => {
  const p = resolve(root, "docker/supabase-ca.crt");
  assert.ok(existsSync(p), "docker/supabase-ca.crt must be committed (empty) — a missing bind-mount source becomes a DIRECTORY");
  assert.ok(statSync(p).isFile());
  const body = readFileSync(p, "utf8");
  assert.ok(
    body.trim() === "" || body.includes("BEGIN CERTIFICATE"),
    "the placeholder must be empty (no CA) or a PEM — anything else is neither",
  );
});

for (const svc of ["migrate", "app", "worker"]) {
  test(`${svc}: receives the CA file and SUPABASE_CA_CERT pointing at it`, () => {
    const block = serviceBlock(read("docker-compose.yml"), svc);
    assert.ok(
      block.split(/\r?\n/).some((l) => l.trim() === `- ${MOUNT}`),
      `${svc} must mount ${MOUNT}`,
    );
    assert.match(
      block,
      new RegExp(`^\\s+SUPABASE_CA_CERT: ${IN_CONTAINER.replaceAll(".", "\\.")}\\s*$`, "m"),
      `${svc} must set SUPABASE_CA_CERT to the in-container path`,
    );
  });
}

test(".env.example no longer sends the operator to a host path no container can read", () => {
  const env = read(".env.example");
  assert.doesNotMatch(env, /^#?\s*SUPABASE_CA_CERT=\/etc\/gml/m);
  assert.match(env, /docker\/supabase-ca\.crt/, ".env.example must say where the CA goes");
});
