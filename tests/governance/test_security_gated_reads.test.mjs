// Wiring for the gated-row fixes. The BEHAVIOUR -- a teacher opening a
// colleague sees neither her cycles nor her mentor, quickfind returns only what
// the caller may open, nothing is served without the section password -- is
// executed against Postgres in tests/behaviour/access-control.test.ts, through
// lib/gated-reads.ts and lib/visibility.ts.
//
// That file cannot prove a PAGE calls those reads: a Next page cannot be
// imported by node:test. Every defect here was a surface outside /observation
// and /mentorship that selected the gated tables itself, with a bare id or ILIKE
// predicate and no section gate. So this file pins that no such surface selects
// them directly any more, on source with comments stripped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

// Block comments, then line comments not preceded by ':' or a quote (so URLs
// such as "https://..." and "//" inside string literals survive).
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const AUTH = "apps/web/src/app/(authenticated)";

for (const [file, reads] of [
  [`${AUTH}/repo/teacher/[id]/page.tsx`, ["teacherCycleHistory", "teacherPairingHistory"]],
  ["apps/web/src/app/api/quickfind/route.ts", ["searchCycles", "searchPairings"]],
  [`${AUTH}/repo/session/[id]/page.tsx`, ["linkedCycle"]],
  [`${AUTH}/repo/teachers/page.tsx`, ["cycleCountsByTeacher"]],
  [`${AUTH}/repo/mentor/[id]/page.tsx`, ["mentorRoster"]],
]) {
  test(`${file} reads observation cycles / mentor pairings only through lib/gated-reads`, () => {
    const src = code(read(file));
    assert.doesNotMatch(src, /\.from\(\s*observationCycles\s*\)/, "no direct select from observation_cycles");
    assert.doesNotMatch(src, /\.from\(\s*mentorPairings\s*\)/, "no direct select from mentor_pairings");
    assert.match(src, /from\s+"@\/lib\/gated-reads"/);
    for (const fn of reads) assert.match(src, new RegExp(`\\b${fn}\\(`), `${fn}() must be called`);
    // The access passed in must come from the section-access resolver, which is
    // where the gate grant AND the visibility predicate are both decided.
    assert.match(src, /\b(observationAccess|mentorshipAccess)\(/);
  });
}
