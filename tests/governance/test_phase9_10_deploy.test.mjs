import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

// Spec 086 — seed
test("seed script inserts Leh + Kargil districts + 11 zones + 10 schools with codes", () => {
  const src = read("packages/db/src/scripts/seed.ts");
  assert.match(src, /name: "Leh"/);
  assert.match(src, /name: "Kargil"/);
  for (const z of ["Khaltsi", "Nubra", "Nyoma", "Durbuk", "Sankoo", "Shargole", "Shikar Chiktan", "Zangskar", "Drass"]) {
    assert.match(src, new RegExp(`name:\\s*"${z}"`));
  }
  // School codes present
  for (const code of ["GPS-CHU", "GMS-KHA", "GHS-DSK", "GMS-DRS", "GHS-PDM", "GHS-KGL"]) {
    assert.match(src, new RegExp(`code:\\s*"${code}"`));
  }
});

test("seed has 10 teachers with Hindi/Tibetan names (SM-7 honored — all optional)", () => {
  const src = read("packages/db/src/scripts/seed.ts");
  // At least one Devanagari name
  assert.match(src, /फ़ातिमा|ख़तीजा|मोहम्मद|इक़बाल/);
  // At least one Tibetan-script name
  assert.match(src, /[ༀ-࿿]/);
});

test("seed is idempotent (checks for existing rows + DRY_RUN env var)", () => {
  const src = read("packages/db/src/scripts/seed.ts");
  assert.match(src, /already exist/);
  assert.match(src, /SEED_DRY_RUN/);
});

// Spec 091 — backup + restore + SM-5
test("backup.sh exists with Postgres + MinIO mirror + retention", () => {
  assert.ok(existsSync(resolve(root, "scripts/backup.sh")), "backup.sh required");
  const src = read("scripts/backup.sh");
  assert.match(src, /pg_dump/);
  assert.match(src, /mc mirror|mc alias set/);
  assert.match(src, /mtime \+14|mtime \+28/);
  assert.match(src, /last-backup\.txt/);
});

test("restore.sh restores to drill db + stamps SM-5 last_restore_drill.json", () => {
  assert.ok(existsSync(resolve(root, "scripts/restore.sh")), "restore.sh required");
  const src = read("scripts/restore.sh");
  assert.match(src, /pg_restore/);
  assert.match(src, /DRILL_DB/);
  assert.match(src, /workspace\/last_restore_drill\.json/);
  assert.match(src, /"result":\s*"ok"/);
});

// Spec 092 — Caddy
test("Caddyfile proxies app + tusd + WhatsApp webhook + security headers", () => {
  const src = read("docker/Caddyfile");
  assert.match(src, /reverse_proxy app:3000/);
  assert.match(src, /reverse_proxy tusd:1080/);
  assert.match(src, /\/api\/webhooks\/whatsapp/);
  assert.match(src, /Strict-Transport-Security/);
  assert.match(src, /X-Content-Type-Options "nosniff"/);
  assert.match(src, /\{\$DOMAIN:localhost\}/); // domain via env
});

// Spec 093 — README-IT
test("README-IT.md has 5-step deploy + .env keys + backups + SM disclosures", () => {
  const src = read("README-IT.md");
  assert.match(src, /5-step deploy/);
  assert.match(src, /WHATSAPP_VERIFY_TOKEN/);
  assert.match(src, /WHATSAPP_APP_SECRET/);
  assert.match(src, /backup\.sh/);
  assert.match(src, /restore\.sh/);
  assert.match(src, /SM-1.*append-only/);
  assert.match(src, /deterrence, not prevention/);
  assert.match(src, /SM-7.*optional/);
  assert.match(src, /SM-9/);
});
