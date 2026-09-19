import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SPEC_DIR = "specs/113-docker-compose-boot-smoke";
const QUICKSTART = `${SPEC_DIR}/quickstart.md`;

test("spec 113: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the docs-only smoke spec`,
    );
  }
});

test("spec 113: quickstart.md is substantive (at least 1500 bytes)", () => {
  const size = statSync(resolve(root, QUICKSTART)).size;
  assert.ok(
    size >= 1500,
    `${QUICKSTART} must be at least 1500 bytes (was ${size}); a substantive operator checklist cannot fit in less`,
  );
});

test("spec 113: quickstart.md contains at least 10 numbered ordered-list items", () => {
  const src = read(QUICKSTART);
  // Match markdown ordered-list items at the start of a line: `1.`, `2.`, ... up through `10.` and beyond.
  const matches = src.match(/^\s*\d+\.\s+/gm) || [];
  assert.ok(
    matches.length >= 10,
    `${QUICKSTART} must contain at least 10 numbered list items (found ${matches.length}); the operator checklist requires the full 10-step sequence`,
  );
});

test("spec 113: quickstart.md references the deploy command './scripts/deploy.sh'", () => {
  const src = read(QUICKSTART);
  assert.match(
    src,
    /\.\/scripts\/deploy\.sh/,
    "quickstart.md must reference './scripts/deploy.sh' — step 2 of the smoke checklist boots the stack via this script",
  );
});

test("spec 113: quickstart.md references 'docker compose ps' for service health inspection", () => {
  const src = read(QUICKSTART);
  assert.match(
    src,
    /docker\s+compose\s+ps/,
    "quickstart.md must reference 'docker compose ps' — the operator has to be able to see " +
      "which containers are up and which are unhealthy",
  );
});

test("spec 113: quickstart.md references the /api/health endpoint", () => {
  const src = read(QUICKSTART);
  assert.match(
    src,
    /\/api\/health/,
    "quickstart.md must reference /api/health — step 4 of the smoke checklist curls the endpoint and inspects ok + migrations",
  );
});

// INVERTED. This test used to assert the quickstart named seven services:
// postgres, redis, minio, tusd, app, worker, caddy (plus a one-shot minio-init
// in the prose). Five of those no longer exist, and the assertion is why the
// stale checklist stayed green:
//
//   minio / minio-init  MinIO withdrew their public Docker images — the whole
//                       `minio/*` namespace 404s on pull. Because app and
//                       worker both declared `depends_on: minio:
//                       service_healthy`, NOTHING in the stack could start, on
//                       any machine.
//   tusd                Wrote to a bucket minio-init never created, had no
//                       healthcheck and nothing depended on it, so it failed
//                       silently; its proxy route returned 501 on every branch.
//                       Uploads now go browser-direct to Supabase Storage.
//   redis               A service, a volume and a healthcheck for a queue
//                       carrying under 100 jobs/day. Replaced by a `jobs` table
//                       claimed with FOR UPDATE SKIP LOCKED.
//   postgres            Supabase IS the database. A local Postgres alongside a
//                       Supabase DATABASE_URL meant compose and .env disagreed
//                       about where the data lived.
//
// Telling an operator to expect five containers that cannot exist sends them
// hunting for a fault in a healthy deployment, which is worse than saying
// nothing. The property still worth protecting is the one the original test was
// reaching for: the checklist must describe the boot the operator will actually
// see. So the service list is now DERIVED from docker-compose.yml rather than
// hardcoded — it cannot go stale again the way this one did — and the five
// withdrawn names are pinned absent.
test("spec 113: quickstart.md names exactly the services docker-compose.yml declares", () => {
  const src = read(QUICKSTART).toLowerCase();

  const compose = read("docker-compose.yml").replace(/\r\n/g, "\n");
  const block = compose.match(/^services:[ \t]*\n([\s\S]*?)(?=^\S)/m);
  assert.ok(block, "could not locate the `services:` block in docker-compose.yml");
  const services = [...block[1].matchAll(/^ {2}([a-z][a-z0-9_-]*):[ \t]*$/gm)].map((m) => m[1]);

  assert.deepEqual(
    services.slice().sort(),
    ["app", "caddy", "migrate", "worker"],
    "the stack is four services — migrate (one-shot schema gate), app, worker, caddy. " +
      "If this changed deliberately, the quickstart has to change with it.",
  );

  for (const svc of services) {
    assert.match(
      src,
      new RegExp(`\\b${svc}\\b`),
      `quickstart.md must mention the '${svc}' service — docker-compose.yml declares it, ` +
        `so the operator will see it in 'docker compose ps' and needs to know what it is`,
    );
  }

  // Markdown has no comment syntax, so the quickstart cannot explain the
  // removals inline without tripping this; the history lives in the header of
  // docker-compose.yml and in the comment above, and the operator checklist
  // stays a checklist.
  for (const gone of ["postgres", "redis", "minio", "minio-init", "tusd"]) {
    assert.ok(
      !new RegExp(`\\b${gone}\\b`).test(src),
      `quickstart.md must not mention '${gone}' — that service is gone, and an operator ` +
        `told to look for it will read a healthy 'docker compose ps' as a failure`,
    );
  }
});

test("spec 113: quickstart.md references the SM-5 restore-drill gate", () => {
  const src = read(QUICKSTART);
  // The SM-5 negative test (step 10) is the most important enforcement check.
  assert.match(
    src,
    /SM-5/,
    "quickstart.md must reference 'SM-5' explicitly — step 10 verifies the restore-drill gate refuses stale drills",
  );
  assert.match(
    src,
    /restore[-_ ]drill|check-restore-drill/i,
    "quickstart.md must reference the restore-drill mechanism that backs the SM-5 gate",
  );
});

test("spec 113: quickstart.md includes pass/fail criteria language for each step", () => {
  const src = read(QUICKSTART);
  // Each step should have explicit Pass / Fail markers — count occurrences and require at least 8 of each
  // (some sub-stepped items consolidate, but we need substantive criteria coverage).
  const passCount = (src.match(/\*\*Pass:?\*\*/gi) || []).length;
  const failCount = (src.match(/\*\*Fail:?\*\*/gi) || []).length;
  assert.ok(
    passCount >= 8,
    `quickstart.md must contain at least 8 '**Pass:**' criteria markers (found ${passCount}); each checklist step needs an explicit pass condition`,
  );
  assert.ok(
    failCount >= 8,
    `quickstart.md must contain at least 8 '**Fail:**' criteria markers (found ${failCount}); each checklist step needs an explicit fail condition`,
  );
});

test("spec 113: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line listing the spec-kit + governance test paths");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line (even if 'none — docs-only spec')");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line (none, since this is docs-only)");
});

test("spec 113: spec.md documents the docs-only rationale and acceptance criteria", () => {
  const src = read(`${SPEC_DIR}/spec.md`);
  assert.match(
    src,
    /docs[- ]only/i,
    "spec.md must explicitly call out that this is a docs-only spec — operators and reviewers need that label up front",
  );
  assert.match(
    src,
    /acceptance criteria/i,
    "spec.md must include an 'Acceptance criteria' section enumerating what the governance test verifies",
  );
});

test("spec 113: tasks.md references the IT-operator post-deploy sign-off", () => {
  const src = read(`${SPEC_DIR}/tasks.md`);
  assert.match(
    src,
    /IT operator|operator/i,
    "tasks.md must name the IT operator as the post-deploy actor for the smoke checklist",
  );
  assert.match(
    src,
    /last_smoke\.json/,
    "tasks.md must reference workspace/last_smoke.json — the sign-off file mirroring last_restore_drill.json",
  );
});

test("spec 113: quickstart.md references the seed verification surfaces (/repo/schools and /admin/forms)", () => {
  const src = read(QUICKSTART);
  assert.match(
    src,
    /\/repo\/schools/,
    "quickstart.md must reference /repo/schools — step 6 verifies the Ladakh school seed fixtures landed",
  );
  assert.match(
    src,
    /\/admin\/forms/,
    "quickstart.md must reference /admin/forms — step 7 verifies the spec 104 feedback_forms catalog seed ran",
  );
});
