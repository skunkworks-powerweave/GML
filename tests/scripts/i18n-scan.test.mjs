// scripts/i18n-scan.mjs finds interface text written into the source, and
// leaves code alone. It gates the whole app (tests/governance/
// test_i18n_coverage.test.mjs), so a rule that stops firing would let English
// back onto Hindi and Bhoti pages silently, and a rule that fires on code
// would bury the real findings. Each case is a small file in a temp folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCAN = join(root, "scripts", "i18n-scan.mjs");

/** Findings for one source file. */
function scan(source, name = "Sample.tsx") {
  const dir = mkdtempSync(join(tmpdir(), "i18n-scan-"));
  try {
    writeFileSync(join(dir, name), source);
    const r = spawnSync(process.execPath, [SCAN, "--json", dir], { encoding: "utf8" });
    assert.ok(r.status === 0 || r.status === 1, `scanner crashed: ${r.stderr}`);
    return r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const texts = (findings) => findings.map((f) => `${f.kind}: ${f.text}`);

test("text a person reads is found", () => {
  const found = texts(
    scan(`
      "use client";
      const MESSAGES = { cycle_locked: "This cycle is signed off. Notes are closed." };
      export function Card({ pending }: { pending: boolean }) {
        return (
          <section title="Cycle details">
            <h2>Observation notes</h2>
            <input placeholder="Add a note" aria-label="New note" />
            <Stat label="teachers" />
            <button>{pending ? "Saving…" : "Save note"}</button>
            <p>{\`Signed in as \${"x"}\`}</p>
          </section>
        );
      }
      export const nav = [{ label: "Teachers", href: "/repo/teachers" }];
    `),
  );
  for (const want of [
    "jsx-text: Observation notes",
    'attribute: title="Cycle details"',
    'attribute: placeholder="Add a note"',
    'attribute: aria-label="New note"',
    'attribute: label="teachers"',
    "expression: Saving…",
    "expression: Save note",
    "expression: Signed in as ${}",
    "sentence: This cycle is signed off. Notes are closed.",
    "property: label: Teachers",
  ]) {
    assert.ok(found.includes(want), `missed ${want}; found ${JSON.stringify(found)}`);
  }
});

test("code is not text: directives, classes, styles, comparisons, identifiers, logs, errors", () => {
  const found = texts(
    scan(`
      "use client";
      import { thing } from "some module path";
      export function Card({ mode }: { mode: string }) {
        console.error("could not load the cycle for this user");
        if (mode === "password reset") throw new Error("unreachable state in the card");
        const tabs = (["password", "magic"] as const);
        return (
          <div className="chip chip-lichen" style={{ fontFamily: "var(--serif)", padding: "6px 8px" }} data-testid="cycle card">
            <svg preserveAspectRatio="xMidYMid slice" />
            <a href="/observation/new" aria-sort="descending">{tabs[0]}</a>
            <span className={mode ? "btn btn-sm" : "btn"}>{"42"}</span>
            <time dateTime="2026-09-27">{new Date().toLocaleDateString("en-IN")}</time>
          </div>
        );
      }
    `),
  );
  assert.deepEqual(found, []);
});

test("names and codes that stay as they are in every language are not flagged on their own", () => {
  assert.deepEqual(texts(scan(`export const A = () => <p>GML · RTT · SCORM · WhatsApp · CSV · Q1</p>;`)), []);
  assert.deepEqual(texts(scan(`export const A = () => <p>RTT phases</p>;`)), ["jsx-text: RTT phases"]);
});

test("an i18n-ignore comment exempts its own line and the next", () => {
  const found = texts(
    scan(`
      // i18n-ignore: CSV header, a contract with spreadsheets
      export const HEADER = "Teacher name, School code";
      export const OTHER = "Teacher name, School code"; // i18n-ignore: same header
      export const SHOWN = "Teacher name and school code";
    `, "csv.ts"),
  );
  assert.deepEqual(found, ["sentence: Teacher name and school code"]);
});

test("API routes and test files are not scanned", () => {
  const dir = mkdtempSync(join(tmpdir(), "i18n-scan-"));
  try {
    const api = join(dir, "api", "things");
    spawnSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(api)}, { recursive: true })`]);
    writeFileSync(join(api, "route.ts"), `export const M = "This request is not allowed for you.";`);
    writeFileSync(join(dir, "x.test.tsx"), `export const A = () => <p>Hello there</p>;`);
    const r = spawnSync(process.execPath, [SCAN, "--json", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the key given to t.rich / t.markup is a key, not text", () => {
  assert.deepEqual(texts(scan(`export const A = ({ t }: any) => <p>{t.rich("inbox empty body", { b: (c: any) => c })}</p>;`)), []);
});
