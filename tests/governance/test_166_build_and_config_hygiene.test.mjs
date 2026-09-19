// Governance test for spec 166 — build & config hygiene
// (Workflow Run 16 audit-closure, HIGH-priority hygiene round).
//
// Five hygiene touches under audit:
//
//   1. .gitattributes (CREATED at repo root)
//      — declares `* text=auto eol=lf` as the global default plus
//        explicit binary pins for known file formats.
//
//   2. .env.example (EDITED)
//      — env-var documentation lines: WORKER_CONCURRENCY, TZ,
//        GML_WHATSAPP_NUMBER, GML_HELPDESK_PHONE, GML_HELPDESK_EMAIL,
//        plus the Supabase storage/database surface.
//        PARTLY INVERTED: this list used to include MINIO_BUCKET and
//        used to pin WORKER_CONCURRENCY=2. MinIO is gone from the
//        stack (withdrawn Docker images), and the concurrency default
//        is now 1. Both are explained at the assertions themselves.
//
//   3. package.json (EDITED, root)
//      — three new scripts: typecheck, migrate, seed:all.
//
//   4. apps/worker/eslint.config.mjs + packages/db/eslint.config.mjs
//      (CREATED)
//      — minimal flat-config ESLint setups wiring
//        @typescript-eslint/recommended.
//
//   5. tsconfig.base.json (CREATED) + apps/web/tsconfig.json (EDITED)
//      — repo-root shared TypeScript baseline + proof-of-life
//        adoption by the web app.
//
// Plus the five spec-kit files under specs/166-build-and-config-hygiene/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const GITATTRIBUTES_PATH = ".gitattributes";
const ENV_EXAMPLE_PATH = ".env.example";
const ROOT_PKG_PATH = "package.json";
const WORKER_ESLINT_PATH = "apps/worker/eslint.config.mjs";
const DB_ESLINT_PATH = "packages/db/eslint.config.mjs";
const TSCONFIG_BASE_PATH = "tsconfig.base.json";
const WEB_TSCONFIG_PATH = "apps/web/tsconfig.json";
const WORKER_PKG_PATH = "apps/worker/package.json";
const DB_PKG_PATH = "packages/db/package.json";
const SPEC_DIR = "specs/166-build-and-config-hygiene";

// ---------- Spec-kit + plan.md contract ----------

test("spec 166 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the build-and-config-hygiene spec`,
    );
  }
});

test("spec 166 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // The touched files / paths must be named in plan.md so a reader
  // auditing the contract knows where the surface area actually lives.
  for (const token of [
    ".gitattributes",
    ".env.example",
    "tsconfig.base.json",
    "eslint.config.mjs",
    "package.json",
  ]) {
    assert.match(
      src,
      new RegExp(token.replace(/\./g, "\\.")),
      `plan.md must call out the ${token} touchpoint so the surface is discoverable`,
    );
  }
});

// ---------- (1) .gitattributes ----------

test("spec 166 — .gitattributes exists at the repo root", () => {
  assert.ok(
    existsSync(resolve(root, GITATTRIBUTES_PATH)),
    `${GITATTRIBUTES_PATH} must exist at the repo root to kill CRLF churn on Windows commits`,
  );
});

test("spec 166 — .gitattributes declares `* text=auto eol=lf` as the LF default", () => {
  const src = read(GITATTRIBUTES_PATH);
  // The exact literal — pinning so a future contributor can't
  // soften it to just `eol=lf` (which would be valid syntax but
  // would not catch the binary-vs-text auto-detection that
  // `text=auto` provides) or to the more aggressive `text eol=lf`
  // (which would treat every file as text, risking corruption of
  // any binary that slipped past the explicit pins below).
  assert.match(
    src,
    /\*\s+text=auto\s+eol=lf/,
    ".gitattributes must declare `* text=auto eol=lf` as the global default — `text=auto` so the binary heuristic is load-bearing, `eol=lf` so all detected-text files store with LF in the index",
  );
});

test("spec 166 — .gitattributes pins all required binary file formats", () => {
  const src = read(GITATTRIBUTES_PATH);
  // Each known binary format present in the repo or expected by
  // the WhatsApp ingest pipeline. Pinning each ensures Git stops
  // trying to auto-detect / diff / auto-merge them.
  const requiredPins = [
    "*.pdf",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.mp4",
    "*.mov",
    "*.webm",
    "*.ico",
    "*.woff",
    "*.woff2",
    "*.ttf",
    "*.zip",
    "*.gz",
  ];
  for (const ext of requiredPins) {
    // Look for `<ext> binary` on a single line (with whitespace
    // between). Escape the `.` and `*` characters for the regex.
    const escaped = ext.replace(/[.*]/g, (c) => `\\${c}`);
    assert.match(
      src,
      new RegExp(`${escaped}\\s+binary`),
      `.gitattributes must pin \`${ext} binary\` so Git stops trying to auto-detect or diff this format`,
    );
  }
});

// ---------- (2) .env.example ----------

test("spec 166 — .env.example documents the operator-facing env-vars", () => {
  const src = read(ENV_EXAMPLE_PATH);
  // The knobs the audit team flagged. Pinning each as a
  // leading-anchored declaration (`^KEY=`) so a comment that
  // merely mentions one of them in passing doesn't false-positive.
  //
  // MINIO_BUCKET is no longer in this list, and MUST NOT come back: MinIO is
  // gone from the stack entirely (they withdrew their public Docker images —
  // the whole `minio/*` namespace answers "pull access denied", and because
  // `app` and `worker` declared `depends_on: minio: service_healthy`, nothing
  // could start on any machine). Object storage is Supabase Storage, and the
  // bucket NAMES are rows created by a migration, not an operator knob. A
  // documented variable that nothing reads is worse than an undocumented one:
  // it teaches the operator that this file is not to be trusted, and this file
  // used to carry five of them.
  const requiredKeys = [
    "WORKER_CONCURRENCY",
    "TZ",
    "GML_WHATSAPP_NUMBER",
    "GML_HELPDESK_PHONE",
    "GML_HELPDESK_EMAIL",
    // Replacing MINIO_BUCKET: the storage surface an operator must now supply.
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "BACKUP_ROOT",
  ];
  for (const key of requiredKeys) {
    assert.match(
      src,
      new RegExp(`^${key}=`, "m"),
      `.env.example must declare \`${key}=...\` on its own line so a new operator copying the file to .env sees the knob explicitly`,
    );
  }
  for (const dead of ["MINIO_BUCKET", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "REDIS_URL", "TUSD_INTERNAL_URL"]) {
    assert.ok(
      !new RegExp(`^${dead}=`, "m").test(src),
      `.env.example must not declare ${dead}= — the service that read it no longer exists`,
    );
  }
});

test("spec 166 — WORKER_CONCURRENCY default is 1 and agrees in all three places", () => {
  const src = read(ENV_EXAMPLE_PATH);
  // Was: `^WORKER_CONCURRENCY=2\b`. The default is now ONE. A single ffmpeg at
  // -preset veryfast already saturates both vCPUs of the target instance; a
  // second starves the web tier it shares the box with, so the old default
  // shipped a self-inflicted outage under load. Queue depth absorbs bursts —
  // that is what a queue is for.
  assert.match(
    src,
    /^WORKER_CONCURRENCY=1\b/m,
    ".env.example must default WORKER_CONCURRENCY=1 (one ffmpeg saturates both vCPUs; the worker clamps the env-var to [1, 16])",
  );

  // Stronger than the original: reconcile the three declarations against each
  // other instead of hard-coding a literal in one of them. The old test pinned
  // `=2` "matching the existing code", which is exactly the kind of pin that
  // silently stops matching when the code moves.
  const workerSrc = read("apps/worker/src/index.ts");
  const codeDefault = workerSrc.match(/process\.env\.WORKER_CONCURRENCY\s*\?\?\s*"(\d+)"/);
  assert.ok(codeDefault, "apps/worker/src/index.ts must read WORKER_CONCURRENCY with a literal fallback");
  assert.equal(
    codeDefault[1],
    "1",
    "the worker's own fallback must be 1, so an unset variable behaves like the documented default",
  );
  const composeDefault = read("docker-compose.yml").match(
    /WORKER_CONCURRENCY:\s*\$\{WORKER_CONCURRENCY:-(\d+)\}/,
  );
  assert.ok(composeDefault, "docker-compose.yml must default WORKER_CONCURRENCY");
  assert.equal(
    composeDefault[1],
    codeDefault[1],
    "compose and the worker must agree on the concurrency default",
  );
});

test("spec 166 — .env.example TZ default is Asia/Kolkata", () => {
  const src = read(ENV_EXAMPLE_PATH);
  // The retention cron is scheduled at 03:00 local. The default
  // TZ must be the LMS deployment region (Ladakh → IST →
  // Asia/Kolkata) so the cron fires at the intended hour.
  assert.match(
    src,
    /^TZ=Asia\/Kolkata\b/m,
    ".env.example must default TZ=Asia/Kolkata so the retention cron fires at 03:00 IST in the default LMS deployment region",
  );
});

// ---------- (3) Root package.json scripts ----------

test("spec 166 — root package.json declares typecheck, migrate, and seed:all scripts", () => {
  const src = read(ROOT_PKG_PATH);
  const parsed = JSON.parse(src);
  const scripts = parsed.scripts || {};
  // The three new scripts the audit asked for. Pin each by name
  // AND check the actual command shape so a future contributor
  // can't redirect e.g. `migrate` to point at a wrong package.
  assert.equal(
    scripts.typecheck,
    "pnpm -r --if-present typecheck",
    "root package.json must declare `typecheck` as `pnpm -r --if-present typecheck` so packages without the script are gracefully skipped",
  );
  assert.equal(
    scripts.migrate,
    "pnpm --filter @gml/db migrate",
    "root package.json must declare `migrate` as `pnpm --filter @gml/db migrate` because only @gml/db owns the live DB surface",
  );
  assert.equal(
    scripts["seed:all"],
    "pnpm --filter @gml/db seed:all",
    "root package.json must declare `seed:all` as `pnpm --filter @gml/db seed:all` — same reasoning as migrate",
  );
});

// ---------- (4) ESLint configs for worker + db ----------

test("spec 166 — apps/worker/eslint.config.mjs exists and is a flat-config array", () => {
  assert.ok(
    existsSync(resolve(root, WORKER_ESLINT_PATH)),
    `${WORKER_ESLINT_PATH} must exist so \`pnpm -r lint\` doesn't silently skip the worker`,
  );
  const src = read(WORKER_ESLINT_PATH);
  // Flat config (ESLint 9 style) is an array. Pin the
  // `export default [` shape so a future contributor can't
  // accidentally regress to the legacy `module.exports = {}`
  // CommonJS shape.
  assert.match(
    src,
    /export\s+default\s*\[/,
    "apps/worker/eslint.config.mjs must be a flat-config array (ESLint 9 style — `export default [ ... ]`)",
  );
  // The @typescript-eslint plugin + parser imports must be present.
  assert.match(
    src,
    /@typescript-eslint\/parser/,
    "apps/worker/eslint.config.mjs must import from @typescript-eslint/parser for TS parsing",
  );
  assert.match(
    src,
    /@typescript-eslint\/eslint-plugin/,
    "apps/worker/eslint.config.mjs must import from @typescript-eslint/eslint-plugin to load the recommended rule set",
  );
  // The recommended rule-set spread.
  assert.match(
    src,
    /recommended\.rules/,
    "apps/worker/eslint.config.mjs must spread `tsPlugin.configs.recommended.rules` so the recommended set is the active baseline",
  );
});

test("spec 166 — packages/db/eslint.config.mjs exists and is a flat-config array", () => {
  assert.ok(
    existsSync(resolve(root, DB_ESLINT_PATH)),
    `${DB_ESLINT_PATH} must exist so \`pnpm -r lint\` doesn't silently skip the db package`,
  );
  const src = read(DB_ESLINT_PATH);
  // Same three pins as the worker config — flat-config array
  // shape, @typescript-eslint imports, recommended rule spread.
  assert.match(
    src,
    /export\s+default\s*\[/,
    "packages/db/eslint.config.mjs must be a flat-config array",
  );
  assert.match(
    src,
    /@typescript-eslint\/parser/,
    "packages/db/eslint.config.mjs must import from @typescript-eslint/parser",
  );
  assert.match(
    src,
    /@typescript-eslint\/eslint-plugin/,
    "packages/db/eslint.config.mjs must import from @typescript-eslint/eslint-plugin",
  );
  assert.match(
    src,
    /recommended\.rules/,
    "packages/db/eslint.config.mjs must spread the recommended rule set",
  );
});

test("spec 166 — worker + db package.json carry the typescript-eslint devDependencies", () => {
  // The two new dev-deps that the new lint configs need. Pin both
  // packages on both worker + db so a future contributor can't
  // accidentally remove them and end up with a config that fails
  // to load.
  for (const pkgPath of [WORKER_PKG_PATH, DB_PKG_PATH]) {
    const parsed = JSON.parse(read(pkgPath));
    const dev = parsed.devDependencies || {};
    assert.ok(
      dev["@typescript-eslint/eslint-plugin"],
      `${pkgPath} must declare @typescript-eslint/eslint-plugin as a devDependency so the lint config can load it`,
    );
    assert.ok(
      dev["@typescript-eslint/parser"],
      `${pkgPath} must declare @typescript-eslint/parser as a devDependency so the lint config can load it`,
    );
  }
});

// ---------- (5) tsconfig.base.json + web extends ----------

test("spec 166 — tsconfig.base.json exists at the repo root with the strict baseline", () => {
  assert.ok(
    existsSync(resolve(root, TSCONFIG_BASE_PATH)),
    `${TSCONFIG_BASE_PATH} must exist at the repo root as the shared TypeScript baseline`,
  );
  // The file may carry a top-level `_comment` for documentation so
  // we tolerate that — strict JSON parsers don't choke on unknown
  // top-level keys, and tsc itself ignores `_comment`.
  const src = read(TSCONFIG_BASE_PATH);
  const parsed = JSON.parse(src);
  const opts = parsed.compilerOptions || {};
  // Pin each of the required baseline keys. A future contributor
  // can ADD more keys but can't remove any of these without
  // breaking the test — which is exactly the regression-proofing
  // contract this spec asks for.
  assert.equal(opts.target, "ES2022", "tsconfig.base.json must target ES2022 — modern Node + bundler-friendly");
  assert.equal(opts.module, "ESNext", "tsconfig.base.json must use module ESNext");
  assert.equal(opts.moduleResolution, "Bundler", "tsconfig.base.json must use moduleResolution Bundler");
  assert.equal(opts.composite, true, "tsconfig.base.json must enable composite for tsc -b reference builds");
  assert.equal(opts.strict, true, "tsconfig.base.json must enable strict — non-negotiable");
  assert.equal(opts.skipLibCheck, true, "tsconfig.base.json must enable skipLibCheck (perf + tolerance for third-party type drift)");
  assert.equal(opts.esModuleInterop, true, "tsconfig.base.json must enable esModuleInterop");
  assert.equal(opts.isolatedModules, true, "tsconfig.base.json must enable isolatedModules (required for bundler transpilers like swc / esbuild)");
});

test("spec 166 — apps/web/tsconfig.json extends from the base (proof-of-life adoption)", () => {
  const src = read(WEB_TSCONFIG_PATH);
  const parsed = JSON.parse(src);
  // Pin the extends path. The web app sits at apps/web/, so the
  // relative path to the repo-root base is `../../tsconfig.base.json`.
  assert.equal(
    parsed.extends,
    "../../tsconfig.base.json",
    "apps/web/tsconfig.json must extend from `../../tsconfig.base.json` so the shared baseline is the inherited start point",
  );
});

test("spec 166 — research.md documents the deferred rollout of tsconfig.base.json to other packages", () => {
  // The spec explicitly DOES NOT mass-rewrite every tsconfig in
  // this run — apps/web is the proof-of-life, the rest is a
  // tracked follow-up. The deferral should be documented in
  // research.md so a future contributor reading the base file
  // doesn't get confused why only one package extends it.
  const src = read(`${SPEC_DIR}/research.md`);
  assert.match(
    src,
    /follow-up|follow up|future/i,
    `${SPEC_DIR}/research.md must document that adopting tsconfig.base.json for the other packages is a follow-up (so a future contributor understands the scope of this run)`,
  );
});

// ---------- No-regression / hygiene ----------

test("spec 166 — root package.json still has the pre-existing lint, build, and test scripts", () => {
  const parsed = JSON.parse(read(ROOT_PKG_PATH));
  const scripts = parsed.scripts || {};
  // Belt-and-suspenders: a future contributor could accidentally
  // overwrite the scripts block while adding the three new ones.
  // Pin the pre-existing forwarders too.
  for (const name of ["lint", "build", "test"]) {
    assert.ok(
      scripts[name],
      `root package.json must keep the pre-existing \`${name}\` script — it was not removed by spec 166`,
    );
  }
});
