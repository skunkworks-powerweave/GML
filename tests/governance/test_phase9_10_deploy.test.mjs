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
  // `rclone copy`, NOT `rclone sync`.
  //
  // The old assertion required `sync`, which is a DESTRUCTIVE mirror: it makes
  // the destination match the source by DELETING destination objects that are
  // absent from it. So a deletion inside Supabase -- accident, bad admin
  // action, compromised key -- would propagate into the disaster-recovery
  // bucket on the next nightly run and destroy the only copy of the videos
  // that is not Supabase's. The test was pinning a backup that would
  // faithfully replicate the disaster it exists to survive, inside 24 hours.
  //
  // `copy` only adds and updates. Pruning belongs to the bucket's lifecycle
  // policy, where it is deliberate and versioned.
  assert.match(src, /rclone copy/, "the object mirror must run via rclone copy");
  assert.ok(
    !/rclone sync/.test(src),
    "`rclone sync` would propagate a Supabase-side deletion into the DR bucket",
  );
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

  // THE CSP MOVED TO THE APPLICATION. Caddy must NOT set one.
  //
  // What stood here asserted `script-src 'self';` in the Caddyfile, with the
  // justification that "a production Next build needs neither 'unsafe-inline'
  // nor 'unsafe-eval'". That is false, and the test was pinning it.
  //
  // A production Next build delivers its entire RSC flight payload through
  // INLINE <script> tags -- six of them on /login, counted against the built
  // image -- and `'self'` does not permit inline script. Every browser would
  // have blocked all six, React would never have hydrated, and the application
  // would have been a dead static shell behind TLS. It went unnoticed because
  // Caddy cannot bind :80 on the development machine, so the header was never
  // once exercised in a browser.
  //
  // The fix needs a fresh nonce per request, which a static reverse-proxy
  // header cannot produce. proxy.ts mints one, sets it on the request so Next
  // stamps it onto every script tag it renders, and sets the matching policy on
  // the response.
  //
  // Caddy must not also send a CSP: two CSP headers are BOTH enforced, and the
  // intersection of a nonce policy with a nonce-less one blocks precisely what
  // the nonce exists to allow. That is what the negative assertion guards.
  assert.ok(
    !/^\s*Content-Security-Policy\s+"/m.test(code(src)),
    "Caddy must NOT set a CSP header — proxy.ts owns it, and two CSP headers intersect",
  );
  assert.match(
    src,
    /Permissions-Policy[^\n]*camera=\(\)[^\n]*microphone=\(\)/,
    "device APIs this product never uses must be switched off — a teacher is holding the device",
  );

  // A dedicated health listener, because the site block matches on Host: a
  // probe of http://127.0.0.1:80 carries Host "127.0.0.1", matches no site and
  // gets a 404, which is why this container reported unhealthy permanently
  // while proxying every real request correctly.
  assert.match(src, /:2021 \{/, "a host-independent health listener is required");
  assert.match(src, /respond \/healthz "ok" 200/);

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
