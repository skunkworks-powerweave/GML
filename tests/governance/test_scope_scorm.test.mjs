// CLAUDE.md's v1-scope claim for SCORM has an implementation behind it (F41).
//
// Locked decision 5 in CLAUDE.md read "v1 scope is FULL: quizzes, SCORM,
// seed data, en/hi/bo i18n" while the codebase had no SCORM code at all: no
// schema, no upload, no launch, no tracking. Nothing tied the claim to the
// code, so anyone signing off against CLAUDE.md expected a feature that did
// not exist, and nothing said so.
//
// This pins the claim to the pieces that make it true. It is a text-level
// invariant (a document's claim against the tree), which no behaviour test can
// observe; the behaviour itself is tested in tests/behaviour/scorm-*.test.ts,
// which this also requires to exist. If SCORM is ever taken out of scope, drop
// it from CLAUDE.md's line and this test stands down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

const IMPLEMENTATION = {
  "schema + migration": ["packages/db/src/schema/scorm.ts", "packages/db/src/migrations/0041_scorm.sql", "packages/db/src/migrations/_post/009_scorm_bucket.sql"],
  "manifest validation + safe unzip": ["apps/web/src/lib/scorm/package.ts", "apps/web/src/lib/scorm/zip.ts", "apps/web/src/lib/scorm/manifest.ts"],
  "runtime API": ["apps/web/src/lib/scorm/runtime.ts", "apps/web/src/app/api/scorm/attempts/[id]/route.ts"],
  "same-origin content": ["apps/web/src/app/api/scorm/content/[id]/[...path]/route.ts"],
  launch: ["apps/web/src/app/(authenticated)/scorm/[id]/page.tsx", "apps/web/src/app/(authenticated)/scorm/[id]/player.tsx"],
  "upload + staff view": ["apps/web/src/app/api/scorm/packages/route.ts", "apps/web/src/app/(authenticated)/admin/scorm/page.tsx", "apps/web/src/app/(authenticated)/admin/scorm/[id]/page.tsx"],
  "behaviour tests": [
    "tests/behaviour/scorm-package.test.ts",
    "tests/behaviour/scorm-runtime.test.ts",
    "tests/behaviour/scorm-content.test.ts",
    "tests/behaviour/scorm-upload.test.ts",
  ],
};

test("F41: CLAUDE.md claims SCORM in v1 scope only while SCORM exists", () => {
  const scopeLine = read("CLAUDE.md")
    .split("\n")
    .find((l) => /v1 scope/i.test(l));
  assert.ok(scopeLine, "CLAUDE.md states the v1 scope");
  if (!/\bSCORM\b/.test(scopeLine)) return;
  const missing = Object.entries(IMPLEMENTATION).flatMap(([part, files]) =>
    files.filter((f) => !existsSync(resolve(root, f))).map((f) => `${part}: ${f}`),
  );
  assert.deepEqual(missing, [], "CLAUDE.md says SCORM is in v1 scope; every part of it must exist");
});

test("F41: the RTT subject page links learners to their SCORM modules", () => {
  const page = read("apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
  assert.match(page, /subjectPackages\(/, "the subject page lists the subject's packages");
  assert.match(page, /\/scorm\/\$\{p\.id\}/, "and links each to its launch page");
});
