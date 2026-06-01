import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SEED_PATH = "packages/db/src/scripts/seed.ts";
const RETENTION_PATH = "packages/db/src/scripts/retention.ts";
const DB_PACKAGE_JSON = "packages/db/package.json";
const DB_TSCONFIG = "packages/db/tsconfig.json";
const SPEC_DIR = "specs/112-pre-existing-ts-cleanup";

test("spec 112: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 112: retention.ts does NOT import from '../src/schema/...' (stale relative path)", () => {
  // The bug: `from "../src/schema/notifications"` resolves to
  // packages/db/src/src/schema/notifications.ts — a non-existent path
  // (the `src/` got duplicated). Spec 107 corrected this; spec 112 guards
  // it against regression.
  const src = read(RETENTION_PATH);
  assert.ok(
    !/from\s*["']\.\.\/src\/schema\//.test(src),
    "retention.ts must not import from '../src/schema/...' (that resolves to packages/db/src/src/...)",
  );
});

test("spec 112: retention.ts imports notifications from the corrected path", () => {
  const src = read(RETENTION_PATH);
  assert.match(
    src,
    /from\s*["']\.\.\/schema\/notifications["']/,
    "retention.ts must import notifications from '../schema/notifications' (relative to src/scripts/)",
  );
});

test("spec 112: seed.ts does NOT array-destructure the result of db.execute() (TS2488 hint)", () => {
  // The bug: `const [districtsCount] = await db.execute(sql...)` — Drizzle's
  // node-postgres .execute() returns a pg QueryResult { rows, rowCount, ... }
  // which is NOT iterable, so the destructure yields undefined at runtime
  // and `tsc` flags TS2488 ("must have a [Symbol.iterator]() method").
  const src = read(SEED_PATH);
  assert.ok(
    !/const\s*\[\s*\w+\s*\]\s*=\s*await\s+db\.execute\s*\(/.test(src),
    "seed.ts must not array-destructure (e.g. `const [x] = await db.execute(...)`) — pg QueryResult is not iterable",
  );
});

test("spec 112: seed.ts accesses .rows[0] on the db.execute() result", () => {
  // The fix: pull the first row out of the QueryResult explicitly.
  const src = read(SEED_PATH);
  assert.match(
    src,
    /\.rows\[\s*0\s*\]/,
    "seed.ts must access `.rows[0]` on the QueryResult returned by db.execute() to read the first row",
  );
});

test("spec 112: seed.ts uses an optional-chain or null-coalesce on the count comparison (total over empty rows)", () => {
  const src = read(SEED_PATH);
  // Either `?.c` or `?? 0` is acceptable — both keep the comparison total
  // when rows[0] is undefined (TS can't prove COUNT(*) always returns a row).
  assert.match(
    src,
    /\?\.\s*c|\?\?\s*0/,
    "seed.ts must use optional-chain (?.c) or null-coalesce (?? 0) to make the count comparison total over an empty rows array",
  );
});

test("spec 112: packages/db/package.json exposes a `typecheck` script", () => {
  const pkg = JSON.parse(read(DB_PACKAGE_JSON));
  assert.ok(
    pkg.scripts && typeof pkg.scripts.typecheck === "string",
    "packages/db/package.json must declare a `typecheck` script",
  );
  assert.match(
    pkg.scripts.typecheck,
    /tsc\s+--noEmit/,
    "typecheck script must invoke `tsc --noEmit`",
  );
});

test("spec 112: packages/db tsconfig.json exists and the typecheck chain is intact", () => {
  // Defensive: confirm the file the typecheck script depends on is still there.
  assert.ok(
    existsSync(resolve(root, DB_TSCONFIG)),
    "packages/db/tsconfig.json must exist for `tsc --noEmit` to function",
  );
  const tsconfig = JSON.parse(read(DB_TSCONFIG));
  assert.ok(
    tsconfig.compilerOptions && tsconfig.compilerOptions.strict === true,
    "packages/db/tsconfig.json must keep `strict: true` so future TS regressions are caught",
  );
  assert.ok(
    tsconfig.compilerOptions.noEmit === true,
    "packages/db/tsconfig.json must keep `noEmit: true` — this package is consumed via source, not built",
  );
});

test("spec 112: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
