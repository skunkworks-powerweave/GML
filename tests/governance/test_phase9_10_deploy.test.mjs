import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

/**
 * `#`-comment-stripped view of a shell script or Caddyfile.
 *
 * Both scripts/backup.sh and docker/Caddyfile now carry headers explaining
 * which piece of infrastructure was removed and why, so any absence assertion
 * has to run against the executable lines only — otherwise the comment
 * describing the removal is what fails the test.
 */
const code = (src) => src.replace(/(^|\s)#.*$/gm, "$1");

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
test("backup.sh exists with Postgres dump + object mirror + retention", () => {
  assert.ok(existsSync(resolve(root, "scripts/backup.sh")), "backup.sh required");
  const src = code(read("scripts/backup.sh"));
  assert.match(src, /pg_dump/);
  // Was: `/mc mirror|mc alias set/`. That command ran inside the `minio` SERVER
  // container, which ships no `mc` binary — `mc` is the separate `minio/mc`
  // image. It exited 127 and, under `set -e`, killed the backup AFTER the DB
  // dump and BEFORE any object was captured: the precise opposite of the
  // script's own "never lose video assets" header. MinIO has since withdrawn
  // the images altogether. Objects now live in Supabase Storage and are
  // mirrored remote-to-remote into an S3 bucket we control.
  assert.ok(
    !/\bmc\s+(mirror|alias)\b/.test(src),
    "backup.sh must not invoke `mc` — the minio server image never contained it",
  );
  assert.match(src, /rclone sync/, "the object mirror must run via rclone");
  // Was: `/mtime \+14|mtime \+28/` — a literal that pinned the number rather
  // than the policy. The retention window is now a named, overridable variable;
  // what still matters is that pruning happens and is bounded.
  assert.match(src, /-mtime "\+\$\{KEEP_DAILY\}" -delete/, "old dumps must be pruned by age");
  assert.match(src, /KEEP_DAILY:-14/, "the retention window must default to 14 days");
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
test("Caddyfile proxies app + WhatsApp webhook + security headers (no tusd)", () => {
  const src = read("docker/Caddyfile");
  assert.match(src, /reverse_proxy app:3000/);
  // Was: `assert.match(src, /reverse_proxy tusd:1080/)`. tusd is gone. It wrote
  // to a bucket (`gml-media`) that `minio-init` never created, had no
  // healthcheck and nothing depended on it — so its failure was silent — and
  // its proxy route returned 501 on every branch because TUSD_INTERNAL_URL was
  // set nowhere. Uploads go browser-direct to Supabase Storage now, so there is
  // nothing to proxy. Comments stripped: the Caddyfile explains the removal.
  assert.ok(
    !/tusd/.test(code(src)),
    "the Caddyfile must not carry an upload proxy route any more",
  );
  assert.match(src, /\/api\/webhooks\/whatsapp/);
  assert.match(src, /Strict-Transport-Security/);
  assert.match(src, /X-Content-Type-Options "nosniff"/);
  assert.match(src, /\{\$DOMAIN:localhost\}/); // domain via env

  // NEW, and load-bearing rather than hygiene: the Supabase auth cookies are
  // NOT httpOnly (the library's own default, because the browser client reads
  // them to drive direct uploads), so an XSS on this origin yields the access
  // token outright. The CSP is what makes that hard to reach in the first
  // place, which is why it is pinned here rather than left to taste.
  assert.match(src, /Content-Security-Policy/, "a CSP is required, not optional");
  assert.match(
    src,
    /script-src 'self';/,
    "script-src must not grant 'unsafe-inline' or 'unsafe-eval' — a production Next build " +
      "needs neither, and granting them would defeat the reason the header exists",
  );
  assert.match(
    src,
    /connect-src 'self' \{\$SUPABASE_ORIGIN/,
    "connect-src must name the Supabase project origin: the browser uploads to Storage and " +
      "fetches HLS segments from signed Storage URLs directly",
  );
  assert.match(
    src,
    /Permissions-Policy[^\n]*camera=\(\)[^\n]*microphone=\(\)/,
    "device APIs this product never uses must be switched off — a teacher is holding the device",
  );

  // The 5 GB body cap belonged to the tusd path. Video no longer transits this
  // proxy in either direction, so leaving it would invite a 5 GB body at an
  // endpoint with no legitimate use for one.
  assert.match(src, /max_size 25MB/, "request bodies must be capped at 25MB now that video bypasses the proxy");
  assert.ok(!/max_size 5GB/i.test(code(src)), "the 5 GB tusd-era body cap must be gone");
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
