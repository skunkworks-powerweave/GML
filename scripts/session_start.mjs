#!/usr/bin/env node
// SessionStart hook — prints a one-line progress summary so each Claude Code session
// boots with awareness of where the project is.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function safeReadJson(rel) {
  try {
    return JSON.parse(readFileSync(resolve(root, rel), "utf8"));
  } catch {
    return null;
  }
}

function countCompletedSpecs() {
  // PROGRESS.md lives at GML root (parent of lms-app/)
  const progressPath = resolve(root, "..", "PROGRESS.md");
  if (!existsSync(progressPath)) return 0;
  const text = readFileSync(progressPath, "utf8");
  // Match real ledger headings: "## YYYY-MM-DD — Spec NNN: ... — COMPLETE"
  // Requires a real date prefix so the template example in code blocks doesn't match.
  const matches = text.match(/^## \d{4}-\d{2}-\d{2} — Spec \d+:.+— COMPLETE$/gm);
  return matches ? matches.length : 0;
}

const state = safeReadJson("workspace/state.json") ?? {};
const completed = countCompletedSpecs();
const total = state.specsTotal ?? 70;
const current = state.currentSpec ?? "?";

console.log(`GML LMS — spec ${current} active · ${completed}/${total} complete`);
process.exit(0);
