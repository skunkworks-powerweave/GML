#!/usr/bin/env node
// Run test suites and leave a RECEIPT that a commit hook can trust.
//
// ── WHY A RECEIPT ────────────────────────────────────────────────────────────
//
// "The tests pass" is a claim about a moment. By the time a commit happens the
// tree may have moved on, and this project's whole history is a lesson in what
// unverified claims cost: a ledger asserting `1549/1549 passing` and
// `PRODUCTION LAUNCH READY` while the application returned HTTP 500 on its own
// login page.
//
// So every `pnpm test*` writes a line recording WHICH suites ran, what they
// returned, and a fingerprint of the exact working tree they ran against. The
// commit hook refuses a commit whose tree does not match a green receipt. That
// turns "I ran the tests" from something asserted into something checkable.
//
// ── WHY IT SHELLS OUT TO pnpm RATHER THAN RUNNING node --test ITSELF ─────────
//
// The suite globs stay in package.json, where tests/governance/test_111 can
// still read them. That test resolves the `pnpm run` chain to prove `pnpm test`
// never reaches tests/integration — smoke needs a booted deployment. If the
// globs moved in here, that guard would go dark.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ONE implementation of the tree fingerprint, imported rather than copied.
//
// This file briefly carried its own copy of treeHash(). The two agreed when
// written — I checked — but that is precisely the arrangement this codebase
// keeps being bitten by: a notification catalogue written out three times with
// "keep in sync" comments, an index declared in two migration lanes, a helper
// duplicated across four test files. The commit gate compares the hash in a
// receipt against the hash it computes itself; if those two ever drifted by a
// byte, every commit would be refused for a reason nobody could see.
import { treeHash } from "../.claude/hooks/_lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPTS = resolve(ROOT, "workspace", "test-receipts.jsonl");

/** Suites this gate knows how to run. Each maps to a package.json script. */
const SUITES = {
  governance: { script: "test:governance", needsDb: false },
  scripts: { script: "test:scripts", needsDb: false },
  hooks: { script: "test:hooks", needsDb: false },
  behaviour: { script: "test:behaviour", needsDb: true },
  web: { script: "test:web", needsDb: true },
  smoke: { script: "test:smoke", needsDb: false, needsStack: true },
};

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
  } catch {
    return "";
  }
}

/** Pull pass/fail counts and failing test names out of TAP output. */
function parseTap(text) {
  const failing = [];
  let passed = 0;
  let failed = 0;
  for (const line of text.split(/\r?\n/)) {
    const notOk = line.match(/^not ok \d+ - (.*)$/);
    if (notOk) failing.push(notOk[1].trim());
    const p = line.match(/^# pass (\d+)/);
    if (p) passed += Number(p[1]);
    const f = line.match(/^# fail (\d+)/);
    if (f) failed += Number(f[1]);
  }
  return { passed, failed, failing };
}

const requested = process.argv.slice(2).filter(Boolean);
if (requested.length === 0) {
  console.error("usage: node scripts/test-gate.mjs <suite>...  (" + Object.keys(SUITES).join(", ") + ")");
  process.exit(2);
}

const unknown = requested.filter((s) => !(s in SUITES));
if (unknown.length) {
  console.error(`[test-gate] unknown suite(s): ${unknown.join(", ")}`);
  process.exit(2);
}

// ── C3(b): the fingerprint is taken BEFORE the suites run ───────────────────
//
// The receipt used to be built entirely after the loop, so `treeHash()` described
// the tree the run LEFT BEHIND rather than the tree it tested. Any suite that
// writes a file — a snapshot, a coverage report, a generated fixture, a stray
// temp directory — moved the tree, and the receipt then vouched for a state that
// nothing had ever executed against. Verified in a sandbox: a suite that wrote
// one file produced a receipt fingerprinting the post-run tree.
//
// `branch` and `head` are captured here too, so every field in the receipt
// describes the same moment. A receipt whose fields disagreed with each other
// would be worse than none, because the commit gate reads them together.
const branchBefore = git(["branch", "--show-current"]);
const headBefore = git(["rev-parse", "HEAD"]);
const treeHashBefore = treeHash();

const ran = [];
let worst = 0;
let noDb = false;

for (const name of requested) {
  const suite = SUITES[name];
  if (suite.needsDb && !process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) {
    // Recorded, not silently skipped. A receipt that claims a database-backed
    // suite ran when no database was reachable is exactly the kind of evidence
    // this file exists to stop being accepted.
    console.error(
      `[test-gate] ${name}: no DATABASE_URL — suite NOT run. The receipt records this, ` +
        `and the commit gate does not accept it as cover for apps/** or packages/** changes.`,
    );
    noDb = true;
    ran.push({ suite: name, ran: false, reason: "no DATABASE_URL" });
    continue;
  }

  const r = spawnSync("pnpm", ["run", suite.script], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 20 * 60_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);

  const tap = parseTap(out);
  const status = r.status ?? 1;
  worst = worst || status;
  ran.push({ suite: name, ran: true, status, ...tap });
}

// If the tree moved while the suites ran, record BOTH rather than quietly
// rebinding the receipt to the new state: `treeHash` stays the tree that was
// TESTED, and `treeHashAfter` tells a consumer the run had side effects. It is
// omitted when nothing moved, so its presence always means something.
const treeHashAfter = treeHash();
const treeMoved = treeHashAfter !== treeHashBefore;

const receipt = {
  ts: new Date().toISOString(),
  branch: branchBefore,
  head: headBefore,
  treeHash: treeHashBefore,
  ...(treeMoved ? { treeHashAfter } : {}),
  suites: ran,
  exitCode: worst,
  noDb,
};

try {
  mkdirSync(dirname(RECEIPTS), { recursive: true });
  appendFileSync(RECEIPTS, `${JSON.stringify(receipt)}\n`);
} catch (err) {
  console.error(`[test-gate] could not write a receipt: ${err.message}`);
  // Not fatal: the tests' own verdict still stands. The commit gate will
  // refuse for lack of a receipt, which is the safe direction.
}

const summary = ran
  .map((s) => (s.ran ? `${s.suite} ${s.failed ? `${s.failed} FAILED` : `${s.passed} ok`}` : `${s.suite} skipped`))
  .join(" · ");
console.error(`[test-gate] ${summary} · exit ${worst} · tree ${receipt.treeHash.slice(0, 12)}`);

if (treeMoved) {
  // Said out loud, because the receipt no longer matches the tree on disk and
  // the next commit will be refused. Silence here would look like a broken gate.
  console.error(
    `[test-gate] the working tree CHANGED while the suites ran ` +
      `(${treeHashBefore.slice(0, 12)} -> ${treeHashAfter.slice(0, 12)}). The receipt ` +
      `fingerprints the tree that was TESTED and records both, so a commit of the tree ` +
      `as it stands now will be refused until the suites are re-run against it.`,
  );
}

process.exit(worst);
