// The operator runbooks (README-deploy.md, README-IT.md, docs/operations.md)
// checked against the repository they describe.
//
// These are documentation defects, so the assertions are necessarily about
// text. Where a runbook states a FACT about the code — a version, a slug, a
// file, a number — the expected value is DERIVED from that code here rather
// than restated, so the test goes red when the two drift apart instead of
// pinning today's wording.
//
// Each block names the defect it guards. Every one of them failed against
// main before the runbooks were corrected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const DEPLOY = read("README-deploy.md");
const IT = read("README-IT.md");
const OPS = read("docs/operations.md");
const pkg = JSON.parse(read("package.json"));

/** The body of a `## N.` / `### N.N` section, up to the next heading of the same or higher level. */
function section(md, heading) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(heading));
  assert.ok(start >= 0, `section "${heading}" not found`);
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  let fenced = false; // `# comment` inside a ```bash block is not a heading
  for (let i = start + 1; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** All ```bash / ```sh fenced blocks, concatenated. */
function shellBlocks(md) {
  return [...md.matchAll(/```(?:bash|sh|cron)\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
}

// ── 1. The host toolchain ────────────────────────────────────────────────────

test("README-deploy 2.5 'Prepare the instance' installs everything deploy.sh checks for, before section 3", () => {
  // deploy.sh needs host docker, node, pnpm and curl, and the first-deploy
  // procedure was: mkdir, clone, cp .env, chmod, deploy.sh — nothing told IT to
  // install ANY of it, so the literal procedure died with `node: command not
  // found` on a stock Ubuntu AMI.
  const idx25 = DEPLOY.indexOf("### 2.5 Prepare the instance");
  const idx3 = DEPLOY.indexOf("## 3. First deploy");
  assert.ok(idx25 > 0 && idx25 < idx3, "section 2.5 must exist and come before the first deploy");
  const s = section(DEPLOY, "### 2.5 Prepare the instance");

  assert.match(s, /docker-ce\b/, "Docker Engine");
  assert.match(s, /docker-compose-plugin/, "the Compose v2 plugin — deploy.sh probes `docker compose version`");
  assert.match(s, /usermod -aG docker/);
  assert.match(s, /log out and back in/i, "the docker group only takes effect in a new login session");
  assert.match(s, /apt-get install -y[^\n]*\bjq\b/);

  const nodeMajor = pkg.engines.node.match(/\d+/)[0];
  assert.match(s, new RegExp(`setup_${nodeMajor}\\.x`), `Node ${nodeMajor} (package.json engines) via NodeSource`);
  const pnpmVersion = pkg.packageManager.replace(/^pnpm@/, "");
  assert.ok(
    s.includes(`corepack prepare pnpm@${pnpmVersion} --activate`),
    `pnpm must be pinned to package.json's packageManager (${pnpmVersion})`,
  );

  // Every binary deploy.sh's toolchain loop demands must be installed here.
  const deploySh = read("scripts/deploy.sh");
  const loop = deploySh.match(/^for cmd in ([^;]+); do/m);
  assert.ok(loop, "deploy.sh's toolchain loop not found");
  for (const tool of loop[1].trim().split(/\s+/)) {
    assert.match(s, new RegExp(`\\b${tool}\\b`), `2.5 must install \`${tool}\` — deploy.sh refuses to run without it`);
  }
  assert.match(deploySh, /README-deploy\.md section 2\.5/, "deploy.sh's failure messages must point here");
});

// ── 4. preflight.sh is invoked by what the docs say invokes it ───────────────

test("the first-deploy procedures run preflight.sh, and no runbook claims deploy.sh runs it", () => {
  // deploy.sh never ran preflight.sh (and must not: it FAILS on ports 80/443
  // being bound, which is every upgrade), while both runbooks said it did.
  for (const [name, md] of [
    ["README-deploy.md", section(DEPLOY, "## 3. First deploy")],
    ["README-IT.md", section(IT, "## 5-step deploy")],
  ]) {
    const pre = md.indexOf("bash scripts/preflight.sh");
    const dep = md.search(/\.\/scripts\/deploy\.sh|bash scripts\/deploy\.sh/);
    assert.ok(pre >= 0, `${name}: the first-deploy procedure must run bash scripts/preflight.sh`);
    assert.ok(pre < dep, `${name}: preflight must run BEFORE the deploy`);
  }
  for (const [name, md] of [["README-deploy.md", DEPLOY], ["README-IT.md", IT]]) {
    assert.doesNotMatch(md, /runs:?\s+preflight\b/i, `${name} must not claim deploy.sh runs preflight`);
  }
  assert.ok(!/preflight\.sh/.test(read("scripts/deploy.sh").replace(/^\s*#.*$/gm, "")), "and it genuinely does not");
});

test("the 50 MB project upload cap is a documented dashboard step, not framed as Free-only", () => {
  const s22 = section(DEPLOY, "### 2.2");
  assert.match(s22, /Upload file size\s+limit/,"raising Storage's project-wide upload limit belongs with the other dashboard steps");
  assert.doesNotMatch(section(DEPLOY, "### 2.1"), /On Free: uploads cap at 50 MB/);
});

// ── 5. The exec bit ──────────────────────────────────────────────────────────

test("README-IT's procedure survives a transfer that drops the exec bit", () => {
  const s = section(IT, "## 5-step deploy");
  assert.match(s, /chmod \+x scripts\/\*\.sh/);
  // The cron lines are the silent failures (their output goes to logs nobody
  // reads), so they must not depend on the bit at all.
  for (const [name, md] of [["README-deploy.md", DEPLOY], ["README-IT.md", IT]]) {
    const cron = shellBlocks(md).split("\n").filter((l) => /\b(backup|restore)\.sh\b/.test(l) && /^\s*#?\s*\d/.test(l));
    assert.ok(cron.length >= 2, `${name}: expected the backup and restore cron lines`);
    for (const l of cron) assert.match(l, /bash scripts\/(backup|restore)\.sh/, `${name}: ${l.trim()}`);
  }
});

// ── 2 + 6. Backups and the drill ─────────────────────────────────────────────

test("section 7 installs the Postgres client from PGDG and says the major must match the server", () => {
  const s = section(DEPLOY, "## 7. Backup and recovery");
  assert.match(s, /apt\.postgresql\.org/, "Ubuntu's own repository tops out below current Supabase majors");
  assert.match(s, /postgresql-client-\d+/);
  assert.doesNotMatch(s, /postgresql-client-16\b/, "client 16 cannot dump a Postgres 17 project");
  assert.match(s, /server_version/, "the operator must be told how to read the server's major");
  assert.match(s, /at least|>=|≥/i, "client major >= server major");
  // The scripts' own hints must not name a guessed client either (comments
  // that record the old hint are history, not advice).
  for (const f of ["scripts/backup.sh", "scripts/preflight.sh"]) {
    const codeOnly = read(f).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.doesNotMatch(codeOnly, /postgresql-client-16/, `${f} still recommends client 16`);
  }
});

test("section 7 documents what the restore drill needs, and DRILL_HOST", () => {
  const s = section(DEPLOY, "## 7. Backup and recovery");
  assert.match(s, /DRILL_HOST/);
  assert.match(s, /container/i, "the drill starts its own throwaway database");
  assert.match(s, /first deploy/i, "the SM-5 gate's first-deploy exception must be documented");
  // cron runs with PATH=/usr/bin:/bin; a snap-installed aws lives in /snap/bin.
  if (/snap install aws-cli/.test(s)) {
    const cronBlock = shellBlocks(s);
    assert.match(cronBlock, /PATH=[^\n]*\/snap\/bin/, "the crontab must put /snap/bin on PATH or backup.sh never ships the dump");
  }
});

test("README-IT says plainly when the SM-5 gate arms", () => {
  const s = section(IT, "## Backups (SM-5)");
  assert.match(s, /first deploy/i);
  assert.match(s, /NODE_ENV/);
});

// ── 9. Quizzes are not seeded ────────────────────────────────────────────────

test("README-deploy does not tell IT the seed ships a quiz catalogue", () => {
  const scriptsDir = resolve(root, "packages/db/src/scripts");
  const seedsQuizzes = readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".ts") && f !== "purge_demo_data.ts")
    .some((f) => /insert\(\s*(quizzes|quizQuestions)\b/.test(readFileSync(resolve(scriptsDir, f), "utf8")));
  if (seedsQuizzes) return; // if a seed ever inserts quizzes, the claim becomes true
  const s = section(DEPLOY, "### 3.1");
  assert.doesNotMatch(s, /quiz catalogues?/i, "nothing in packages/db/src/scripts inserts quizzes");
  assert.doesNotMatch(read("packages/db/src/scripts/purge_demo_data.ts"), /quiz catalogues?/i);

  // This used to require 3.1 to name the fixed slugs the subject page looked
  // for (mid-unit, endline). That lookup was the defect F33: a subject now
  // lists the active quizzes bound to it, so there is no slug for IT to create
  // and 3.1 must not send them looking for one.
  const page = read("apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
  assert.doesNotMatch(page, /assessmentSlugs/, "the subject page looks quizzes up by subject, not by slug");
  assert.doesNotMatch(s, /`(mid-unit|endline)`/, "3.1 must not name fixed quiz slugs no page looks for");
  assert.match(s, /\/admin\/quizzes/);
});

// ── 10. The upgrade command ──────────────────────────────────────────────────

test("every directory a runbook cd's into exists in the clone", () => {
  // README-deploy's upgrade line did `cd gml-lms && git pull && cd lms-app`,
  // a leftover from when the repo root was the parent folder; `&&` meant
  // deploy.sh never ran.
  for (const [name, md] of [["README-deploy.md", DEPLOY], ["README-IT.md", IT]]) {
    for (const m of shellBlocks(md).matchAll(/\bcd\s+([^\s;&|]+)/g)) {
      const dir = m[1];
      if (dir === "gml-lms" || /^[/$~]/.test(dir)) continue; // the clone itself, or absolute
      const p = resolve(root, dir);
      assert.ok(existsSync(p) && statSync(p).isDirectory(), `${name}: \`cd ${dir}\` — no such directory in the repository`);
    }
  }
});

// ── 11. CSP ──────────────────────────────────────────────────────────────────

test("the CSP troubleshooting row points at the code that sets the CSP", () => {
  const row = DEPLOY.split(/\r?\n/).find((l) => /CSP error/.test(l));
  assert.ok(row, "the CSP troubleshooting row is missing");
  assert.match(row, /apps\/web\/src\/lib\/csp\.ts/);
  assert.match(row, /buildCsp/);
  assert.match(read("apps/web/src/lib/csp.ts"), /export function buildCsp\(/, "the named function must exist");
  assert.match(read("apps/web/src/proxy.ts"), /buildCsp\(nonce\)/, "and the proxy must be what sends it");
  assert.match(read("docker/Caddyfile"), /DO NOT reintroduce a CSP here/, "and the Caddyfile must still refuse one");
});

// ── 12. Log rotation ─────────────────────────────────────────────────────────

test("log rotation is described as compose configures it, and nobody is told to restart Docker for it", () => {
  const compose = read("docker-compose.yml");
  const size = compose.match(/max-size:\s*"(\d+)m"/)[1];
  const files = compose.match(/max-file:\s*"(\d+)"/)[1];
  for (const [name, md] of [["README-deploy.md", DEPLOY], ["README-IT.md", IT], ["docs/operations.md", OPS]]) {
    assert.doesNotMatch(md, /daemon\.json/, `${name}: daemon.json log-opts are overridden by every compose service`);
    assert.doesNotMatch(md, /50 ?MB\s*[×x]\s*5/, `${name}: rotation is ${size} MB × ${files}, per compose`);
    assert.doesNotMatch(md, /grow(s)? without bound/i, `${name}: compose caps every service's logs`);
  }
  assert.doesNotMatch(DEPLOY, /systemctl restart docker/);
  assert.match(section(DEPLOY, "### Logs"), new RegExp(`${size} ?MB\\s*[×x]\\s*${files}`));
  assert.match(OPS, new RegExp(`${size} ?MB\\s*[×x]\\s*${files}`));
});
