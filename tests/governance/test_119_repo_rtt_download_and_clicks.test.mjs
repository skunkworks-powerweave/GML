// Governance test for spec 119 — Tier H frontend-parity download/click fixes.
//
// Verifies that the six workflow-blocker buttons identified by the
// frontend-parity audit are wired to real <Link href=…> destinations on
// the live Next.js pages:
//   1. /repo/resource/[id]: View-PDF CTA carries the spec 119 SM-4 ratification comment
//      and still points at /repo/resource/<id>/view (not a download).
//   2. /rtt/subject/[id]: header "Resume" CTA links to an in-page module anchor.
//   3. /rtt/subject/[id]: each module row carries an id="module-<seq>" anchor target.
//   4. /rtt/subject/[id]: session rows use rtt_sessions.link_or_recording
//      (NOT /repo/session/<id>, which reads a different table -- see below).
//   5. /rtt/subject/[id]: each session row has a Join/Watch action button.
//   6. /rtt/subject/[id]: readings with fileKey link to /repo/resource/<reading.id>/view.
//   7. /rtt/subject/[id]: Assessment card emits /quizzes/mid-unit and /quizzes/endline links.
//
// All five spec-kit files exist and the plan follows the CREATED/EDITED/MIGRATED contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const RESOURCE_DETAIL = "apps/web/src/app/(authenticated)/repo/resource/[id]/page.tsx";
const RTT_SUBJECT = "apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx";
const SPEC_DIR = "specs/119-repo-rtt-download-and-clicks";

test("spec 119 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the Tier H frontend-parity spec`,
    );
  }
});

test("spec 119 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /repo\/resource\/\[id\]\/page\.tsx/,
    "plan.md must call out the repo resource detail page in EDITED",
  );
  assert.match(
    src,
    /rtt\/subject\/\[id\]\/page\.tsx/,
    "plan.md must call out the rtt subject page in EDITED",
  );
});

test("spec 119 — /repo/resource/[id] still labels the CTA 'View PDF' (not 'Download')", () => {
  const src = read(RESOURCE_DETAIL);
  // The CTA text is the load-bearing piece. It must say View PDF...
  assert.match(
    src,
    />\s*View PDF\s*</,
    "resource detail must render a 'View PDF' button — SM-4 forbids 'Download' framing",
  );
  // ...and must not silently revert to 'Download PDF'.
  assert.ok(
    !/>\s*Download PDF\s*</.test(src),
    "resource detail must not say 'Download PDF' — anti-download is part of the SM-4 contract",
  );
});

test("spec 119 — /repo/resource/[id] View PDF CTA hrefs /repo/resource/<id>/view", () => {
  const src = read(RESOURCE_DETAIL);
  assert.match(
    src,
    /\/repo\/resource\/\$\{res\.id\}\/view/,
    "View PDF CTA must point at the spec 087 in-browser viewer route",
  );
});

test("spec 119 — /repo/resource/[id] carries a spec 119 SM-4 ratification comment", () => {
  const src = read(RESOURCE_DETAIL);
  // The comment ties the rename to SM-4 so a future drive-by edit can't regress it silently.
  assert.match(
    src,
    /Spec\s*119[\s\S]{0,200}SM-4/,
    "resource detail must carry a Spec 119 comment that names SM-4 — protects the CTA copy from drive-by regressions",
  );
});

test("spec 119 — /rtt/subject/[id] renders a header-level 'Resume' Link", () => {
  const src = read(RTT_SUBJECT);
  // The literal CTA text…
  assert.match(src, />\s*Resume\s*</, "rtt subject page must render a 'Resume' button");
  // …and the link href must compute from the first-module sequence (anchor jump).
  assert.match(
    src,
    /resumeHref/,
    "rtt subject page must derive a resumeHref so the CTA is a real Link, not a dead button",
  );
  assert.match(
    src,
    /#module-/,
    "resumeHref must include a #module-<seq> in-page anchor",
  );
});

test("spec 119 — /rtt/subject/[id] adds id='module-<seq>' anchor targets on each module row", () => {
  const src = read(RTT_SUBJECT);
  // The template literal must be present so the Resume anchor actually resolves.
  assert.match(
    src,
    /id=\{`module-\$\{m\.sequence\}`\}/,
    "each rendered module row must carry id={`module-${m.sequence}`} so the Resume anchor lands somewhere",
  );
});

test("spec 119 — /rtt/subject/[id] session rows do NOT link to /repo/session/<id>", () => {
  const src = read(RTT_SUBJECT);

  // ── THIS ASSERTION IS THE INVERSE OF WHAT IT ORIGINALLY CHECKED ────────────
  //
  // It used to REQUIRE `/repo/session/${s.id}`, and that requirement was the
  // bug. The rows on this page come from `rtt_sessions`; /repo/session/[id]
  // selects from `sessions`. Two different tables, each with its own
  // `uuid primary key default gen_random_uuid()` and no foreign key between
  // them, so an id from one is never an id in the other except by uuid
  // collision. Every session row on every RTT subject page linked to a 404.
  //
  // The test passed throughout, because it asserted the presence of the broken
  // string. Keeping it as a negative is the point: it now fails if anyone
  // reintroduces the cross-table href.
  assert.doesNotMatch(
    src,
    /\/repo\/session\/\$\{s\.id\}/,
    "session rows must not link an rtt_sessions id into /repo/session/[id], which reads the `sessions` table",
  );
  assert.doesNotMatch(
    src,
    /sessionHref/,
    "the sessionHref const built that cross-table URL and should be gone",
  );

  // What replaced it: the row's own meeting link or recording, which is a real
  // column on rtt_sessions and the only URL this page actually has.
  assert.match(
    src,
    /s\.linkOrRecording/,
    "session rows must use rtt_sessions.link_or_recording as their navigation target",
  );
});

test("spec 119 — /rtt/subject/[id] session rows render a Join/Watch action button", () => {
  const src = read(RTT_SUBJECT);
  // Both literals must be present; the row picks one based on scheduledAt vs now.
  assert.match(src, /["']Join["']/, "session row must render the 'Join' label for upcoming sessions");
  assert.match(src, /["']Watch["']/, "session row must render the 'Watch' label for past sessions");
  // The picker uses scheduledAt — verify the comparison is there so the
  // label is not hard-coded one way or the other.
  assert.match(
    src,
    /isUpcoming/,
    "session row must derive an isUpcoming flag from scheduledAt — otherwise Join/Watch is static",
  );
});

test("spec 119 — /rtt/subject/[id] file-key readings link to /repo/resource/<id>/view", () => {
  const src = read(RTT_SUBJECT);
  assert.match(
    src,
    /\/repo\/resource\/\$\{r\.id\}\/view/,
    "fileKey-only readings must link to /repo/resource/${r.id}/view (spec 087 viewer)",
  );
  // The View label must be the visible CTA on that branch.
  assert.match(
    src,
    />\s*View\s*</,
    "fileKey-only readings must render a visible 'View' label so the user knows what the click does",
  );
});

test("spec 119 — /rtt/subject/[id] Assessment card emits quiz hrefs with subjectId", () => {
  const src = read(RTT_SUBJECT);
  // Mid-unit Start link…
  assert.match(
    src,
    /\/quizzes\/mid-unit\?subjectId=\$\{id\}/,
    "Mid-unit Start CTA must link to /quizzes/mid-unit?subjectId=${id}",
  );
  // …and Endline Locked link.
  assert.match(
    src,
    /\/quizzes\/endline\?subjectId=\$\{id\}/,
    "Endline Locked CTA must link to /quizzes/endline?subjectId=${id}",
  );
  // The card must render the literal section title.
  assert.match(
    src,
    />\s*Assessment\s*</,
    "right column must include the 'Assessment' card heading",
  );
});

test("spec 119 — /rtt/subject/[id] preserves the modules anchor fallback", () => {
  const src = read(RTT_SUBJECT);
  // When firstModule is undefined the Resume CTA must still land somewhere.
  assert.match(
    src,
    /#modules/,
    "rtt subject page must include a #modules fallback anchor for subjects with zero modules",
  );
  assert.match(
    src,
    /id="modules"/,
    "the modules card must carry the id='modules' attribute so the fallback anchor resolves",
  );
});

test("spec 119 — /rtt/subject/[id] does NOT introduce any 'use client' boundary", () => {
  const src = read(RTT_SUBJECT);
  // Tier H is a pure server-component wiring exercise — adding client-component scope
  // for these tiny <Link>s would be an unnecessary bundle hit.
  assert.ok(
    !/^\s*["']use client["']/m.test(src),
    "rtt subject page must stay a pure server component — no 'use client' for plain Link wiring",
  );
});

test("spec 119 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [RESOURCE_DETAIL, RTT_SUBJECT]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
    assert.ok(
      !/\bplaceholder\b/i.test(src),
      `${path} must not contain 'placeholder' literals`,
    );
  }
});
