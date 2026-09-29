// Release and deploy workflows (the IT handover, 2026-09-29).
//
//   .github/workflows/release.yml  a version tag re-runs the whole CI gate,
//                                  then publishes the app, worker and migrate
//                                  images to ghcr.io under that version.
//   .github/workflows/deploy.yml   runs scripts/deploy.sh on an environment's
//                                  server over SSH: staging when a release is
//                                  published, production only by hand, only a
//                                  final version, through the "production"
//                                  GitHub environment (where IT adds reviewers).
//
// Source-text checks, like the rest of this tier: they hold the shape, and the
// first real run on IT's servers is what proves the deploy itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const RELEASE = ".github/workflows/release.yml";
const DEPLOY = ".github/workflows/deploy.yml";

test("174 — release: only a version tag publishes, and only after the full CI gate passes", () => {
  assert.ok(existsSync(resolve(root, RELEASE)), `${RELEASE} exists`);
  const src = read(RELEASE);
  assert.match(src, /on:\s*\n\s*push:\s*\n\s*tags:\s*\[\s*"v\*\.\*\.\*"\s*\]/, "triggered by v*.*.* tags and nothing else");
  assert.doesNotMatch(src, /branches:/, "never on a branch push");
  assert.match(src, /uses:\s*\.\/\.github\/workflows\/test\.yml/, "re-runs test.yml as a reusable workflow");
  assert.match(src, /needs:\s*ci\b/, "images wait for that gate");
  assert.match(read(".github/workflows/test.yml"), /^\s*workflow_call:\s*$/m, "test.yml can be called");
});

test("174 — release: the three images go to ghcr.io under the version, with only packages: write", () => {
  const src = read(RELEASE);
  for (const image of ["app", "worker", "migrate"]) {
    assert.ok(existsSync(resolve(root, `docker/${image}.Dockerfile`)), `docker/${image}.Dockerfile exists`);
  }
  assert.match(src, /image:\s*\[\s*app,\s*worker,\s*migrate\s*\]/, "a matrix over the three images");
  assert.match(src, /file:\s*docker\/\$\{\{\s*matrix\.image\s*\}\}\.Dockerfile/);
  assert.match(src, /registry:\s*ghcr\.io/);
  assert.match(src, /type=semver,pattern=\{\{version\}\}/, "tagged with the release version");
  assert.match(src, /push:\s*true/);
  assert.match(src, /packages:\s*write/);
  assert.match(src, /^permissions:\s*\n\s*contents:\s*read\s*$/m, "read-only by default");
  const secrets = [...src.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)], ["GITHUB_TOKEN"], "no secret but the workflow's own token");
});

test("174 — deploy: staging on a published release, production only by hand", () => {
  assert.ok(existsSync(resolve(root, DEPLOY)), `${DEPLOY} exists`);
  const src = read(DEPLOY);
  assert.match(src, /release:\s*\n\s*types:\s*\[\s*published\s*\]/);
  assert.match(src, /workflow_dispatch:/);
  assert.match(src, /options:\s*\[\s*staging,\s*production\s*\]/);
  assert.match(
    src,
    /environment:\s*\$\{\{\s*github\.event_name == 'release' && 'staging' \|\| inputs\.environment\s*\}\}/,
    "a release goes to staging; production is reachable only through workflow_dispatch",
  );
  assert.match(src, /cancel-in-progress:\s*false/, "a second deploy queues; it never kills one half-way");
});

test("174 — deploy: the tag is checked before it reaches a shell, and production takes a final version only", () => {
  const src = read(DEPLOY);
  assert.match(src, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\(-rc\\\.\[0-9\]\+\)\?\$/, "a strict version pattern");
  assert.match(src, /production[\s\S]{0,200}-rc/, "an -rc tag is refused for production");
  assert.match(src, /tag:[\s\S]{0,80}type:\s*string/);
  // The tag is passed through env, never interpolated into a run: script.
  assert.doesNotMatch(src, /run:[^\n]*\$\{\{\s*(inputs\.tag|github\.event\.release\.tag_name)/);
});

test("174 — deploy: SSH checks the host key, and runs the documented upgrade on the server", () => {
  const src = read(DEPLOY);
  assert.match(src, /StrictHostKeyChecking=yes/);
  assert.match(src, /BatchMode=yes/);
  assert.doesNotMatch(src, /StrictHostKeyChecking=no/);
  assert.match(src, /git fetch --tags --force origin/);
  assert.match(src, /git checkout --detach/);
  assert.match(src, /\.\/scripts\/deploy\.sh/);
  assert.match(src, /api\/health/, "and checks health through the public URL afterwards");
  for (const name of ["DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"]) {
    assert.match(src, new RegExp(`secrets\\.${name}\\b`), `${name} comes from the environment's secrets`);
  }
  // Nothing uses a third-party action: the key and the host are handled by
  // ssh itself, so no one else's code sees them.
  const actions = [...src.matchAll(/uses:\s*([^\s@]+)@/g)].map((m) => m[1]);
  assert.deepEqual(actions.filter((a) => !a.startsWith("actions/")), [], "only GitHub's own actions");
});

test("174 — the workflows README points at both new workflows and stays short", () => {
  const src = read(".github/workflows/README.md");
  assert.match(src, /release\.yml/);
  assert.match(src, /deploy\.yml/);
  assert.ok(src.split(/\r?\n/).length < 15);
});
