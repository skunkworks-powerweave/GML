// The PR template must not satisfy the merge gate by itself.
//
// ── THE DEFECT THIS EXISTS FOR (C1) ──────────────────────────────────────────
//
// `.github/pull_request_template.md` explained the merge rule by quoting it, and
// the quote was the rule:
//
//     It must stay at the start of a line and read exactly
//     `Review-Verdict:` + ` approved` to merge; anything else ... blocks.
//
// (That quote is split on purpose, and so are the two later ones: written as
// one string, each would make THIS file carry a satisfying line too, and a test
// about not shipping one should not ship one. Three files still do —
// `.claude/hooks/pre-bash.mjs`, whose refusal text shows the reviewer what to
// write, and `tests/hooks/pre-bash.test.mjs` and
// `tests/hooks/settings-wiring.test.mjs`, which need it as a fixture. None of
// the three is ever a PR body. The splitting is the only liberty taken with
// the quotes.)
//
// pre-bash.mjs's merge rule tests the PR body with
//
//     const VERDICT = /Review-Verdict:\s*approved/i;
//
// which is UNANCHORED. So the substring inside that sentence matched, and every
// pull request opened from the unedited default template cleared the merge gate
// with no review of any kind. Verified before the fix: VERDICT.test(template)
// === true, matching the literal "Review-Verdict:" + " approved" on line 66 —
// inside the prose that describes the gate, not inside the field a reviewer
// fills in.
//
// That is the whole class of failure this repository keeps producing: a control
// that reads as installed and enforces nothing. A template that ships its own
// approval is worse than no gate, because the PR body then carries a line that
// looks like a human wrote it.
//
// ── WHY THE REGEX IS READ OUT OF THE HOOK RATHER THAN RETYPED ────────────────
//
// pre-bash.mjs cannot be imported: it is a hook, so importing it reads stdin and
// calls process.exit. Retyping the pattern here would let the two drift — the
// test would keep passing against a regex the gate no longer uses, which is
// exactly how the 28 pinning assertions in this repository came to exist. So the
// live pattern is EXTRACTED from the hook's source text and compiled. If someone
// changes the regex in pre-bash.mjs, this test changes with it.
//
// The template is also checked against the ANCHORED form
// /^[ \t]*Review-Verdict:[ \t]*approved[ \t]*$/im. That anchoring HAS landed —
// the live regex is now the same shape with a `\r?` before the `$`, so a CRLF
// body still matches — and asserting both forms keeps this test from quietly
// becoming a tautology against whatever the hook happens to say. The comment
// that stood here described the anchoring as still to come, in the commit that
// landed it; the assertions were right and the sentence was not.
//
// Nothing here mutates the repository: two files are read, and that is all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const TEMPLATE = resolve(ROOT, ".github", "pull_request_template.md");
const HOOK = resolve(ROOT, ".claude", "hooks", "pre-bash.mjs");

/** The anchored form the merge rule should use. See I6. */
const ANCHORED = /^[ \t]*Review-Verdict:[ \t]*approved[ \t]*$/im;

/**
 * The merge gate's verdict pattern, as pre-bash.mjs actually declares it.
 *
 * Source-text extraction rather than an import, because importing a hook runs
 * it. The declaration is matched in full — name, literal and flags — so a
 * rename or a move to a different construct fails loudly here instead of
 * silently falling back to a stale copy.
 */
function liveVerdictRegex() {
  const src = readFileSync(HOOK, "utf8");
  const m = /const\s+VERDICT\s*=\s*\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/([a-z]*)\s*;/.exec(src);
  assert.ok(
    m,
    "could not find `const VERDICT = /.../;` in .claude/hooks/pre-bash.mjs. " +
      "If the merge rule moved, move this extraction with it — a test that " +
      "cannot find the rule it checks is not checking anything.",
  );
  return new RegExp(m[1], m[2]);
}

test("the unedited PR template does not satisfy the merge gate's verdict rule", () => {
  const body = readFileSync(TEMPLATE, "utf8");
  const verdict = liveVerdictRegex();
  const hit = body.match(verdict);

  assert.equal(
    hit,
    null,
    `.github/pull_request_template.md already satisfies ${verdict} as shipped ` +
      `(matched ${JSON.stringify(hit && hit[0])}). A PR opened from this ` +
      `template would clear the merge gate before anyone read the diff. ` +
      `Describe the verdict line without writing a satisfying one — say what ` +
      `the field must be CHANGED to, and leave the field itself unapproved.`,
  );
});

test("the template does not satisfy the anchored verdict rule either", () => {
  // Guards the fix against being undone by the I6 anchoring. An unanchored
  // regex is the stricter test of the two here (it matches prose as well as
  // fields), so this cannot fail while the test above passes -- until the
  // anchoring lands, at which point this becomes the one that means something.
  const body = readFileSync(TEMPLATE, "utf8");
  assert.equal(
    ANCHORED.test(body),
    false,
    ".github/pull_request_template.md carries a line that reads exactly " +
      "`Review-Verdict:` followed by ` approved`. The template must ship the " +
      "field unapproved.",
  );
});

test("the template still carries a Review-Verdict field to fill in", () => {
  // The cheap way to pass the two tests above is to delete the section, which
  // would take the merge gate's only input with it: pre-bash.mjs reads the PR
  // BODY, so a field nobody is prompted for is a field nobody writes, and the
  // gate then blocks every merge for a reason the template never explains.
  const body = readFileSync(TEMPLATE, "utf8");
  assert.match(
    body,
    /^[ \t]*Review-Verdict:[ \t]*\S*[ \t]*$/im,
    "the template must still prompt for a `Review-Verdict:` line — that line " +
      "is what .claude/hooks/pre-bash.mjs greps the PR body for.",
  );
});
