import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ORCH_PATH = "packages/db/src/scripts/seed_all.ts";
const SPEC_DIR = "specs/104-form-catalog-seed-runner";
const PKG_PATH = "packages/db/package.json";

const SUB_SCRIPTS = [
  "seed",
  "seed_forms_mentor",
  "seed_forms_mentee",
  "seed_forms_observation",
  "seed_forms_misc",
];

test("spec 104: seed_all.ts exists at packages/db/src/scripts/seed_all.ts", () => {
  assert.ok(existsSync(resolve(root, ORCH_PATH)), `${ORCH_PATH} must exist`);
});

test("spec 104: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 104: orchestrator references all 5 sub-scripts by name", () => {
  const src = read(ORCH_PATH);
  for (const name of SUB_SCRIPTS) {
    assert.match(
      src,
      new RegExp(`\\b${name}\\b`),
      `orchestrator must reference ${name}`,
    );
  }
});

test("spec 104: orchestrator imports main() from each of the 5 sub-script modules", () => {
  const src = read(ORCH_PATH);
  // Each sub-script is imported as a module file path; the orchestrator must
  // import a `main` symbol from each (either as `{ main }` or under a renamed alias).
  for (const name of SUB_SCRIPTS) {
    const importRe = new RegExp(
      `import\\s*\\{[^}]*\\bmain\\b[^}]*\\}\\s*from\\s*["']\\./${name}\\.js["']`,
    );
    assert.match(
      src,
      importRe,
      `orchestrator must import main() from ./${name}.js`,
    );
  }
});

test("spec 104: orchestrator loads dotenv before invoking phases", () => {
  const src = read(ORCH_PATH);
  assert.match(src, /import\s+["']dotenv\/config["']/);
});

test("spec 104: orchestrator runs phases sequentially with await + iterates a phase list", () => {
  const src = read(ORCH_PATH);
  // Sequential execution requires `for … of` (not `Promise.all`).
  assert.match(src, /for\s*\(\s*const\s+\w+\s+of\s+PHASES\s*\)/);
  // And each phase invocation must be awaited.
  assert.match(src, /await\s+\w+\.run\(\)/);
});

test("spec 104: orchestrator exits with code 1 on phase failure", () => {
  const src = read(ORCH_PATH);
  assert.match(src, /process\.exit\(1\)/);
  // And there must be a try/catch around the phase invocation so failures surface.
  assert.match(src, /catch\s*\(\s*\w+\s*\)/);
});

test("spec 104: package.json exposes a 'seed:all' script that invokes seed_all.ts via tsx", () => {
  const pkg = JSON.parse(read(PKG_PATH));
  assert.ok(pkg.scripts, "package.json must have a scripts block");
  assert.ok(
    pkg.scripts["seed:all"],
    "package.json scripts must contain 'seed:all'",
  );
  assert.match(
    pkg.scripts["seed:all"],
    /tsx\s+src\/scripts\/seed_all\.ts/,
    "'seed:all' must invoke src/scripts/seed_all.ts via tsx",
  );
});

test("spec 104: each sub-script exports main() (not a private async function)", () => {
  for (const name of SUB_SCRIPTS) {
    const src = read(`packages/db/src/scripts/${name}.ts`);
    assert.match(
      src,
      /export\s+async\s+function\s+main\b/,
      `${name}.ts must declare 'export async function main(' so the orchestrator can import it`,
    );
  }
});

test("spec 104: each sub-script guards auto-run behind the entry-point check (so imports don't auto-run)", () => {
  for (const name of SUB_SCRIPTS) {
    const src = read(`packages/db/src/scripts/${name}.ts`);
    // Must import pathToFileURL from node:url and use it in an entry-point guard.
    assert.match(
      src,
      /import\s*\{\s*pathToFileURL\s*\}\s*from\s*["']node:url["']/,
      `${name}.ts must import pathToFileURL from node:url for the entry-point guard`,
    );
    assert.match(
      src,
      /import\.meta\.url\s*===\s*pathToFileURL\(/,
      `${name}.ts must guard auto-run with 'import.meta.url === pathToFileURL(...)'`,
    );
  }
});

test("spec 104: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});

test("spec 104: orchestrator emits per-phase timing logs", () => {
  const src = read(ORCH_PATH);
  // Per-phase timing requires a Date.now()-derived elapsed value the operator
  // can see between phase boundaries.
  assert.match(src, /Date\.now\(\)/);
  // Log lines must mention the phase boundary so the operator can correlate
  // a slow phase to a specific sub-script.
  assert.match(src, /\[seed:all\]/);
});

test("spec 104: no stub / TODO / placeholder markers in the orchestrator", () => {
  const src = read(ORCH_PATH);
  assert.ok(!/\bTODO\b/i.test(src), "orchestrator must not contain TODO markers");
  assert.ok(!/\bFIXME\b/i.test(src), "orchestrator must not contain FIXME markers");
  assert.ok(!/placeholder/i.test(src), "orchestrator must not contain 'placeholder' literals");
});
