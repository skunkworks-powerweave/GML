// Governance test for spec 122 — Help panel + dictionary
// (frontend-parity Run 10 revival).
//
// Verifies that the JSX prototype's full help system is faithfully ported:
//   • HELP dictionary carries every prototype slug (~50 entries) including
//     the status_* pills, role_* pills and video-pipeline topics.
//   • HelpPanel is a 'use client' island that owns the gml:open-help event,
//     the ? shortcut, the search input, the related-topic chips, the
//     Browse-all grouped list and the "Talk to a person" card with three
//     real wired actions (wa.me / mailto: / POST /api/helpdesk/tickets).
//   • HelpTip / HelpDot / HelpHeadbtn / useHelpShortcut are present and
//     compile as 'use client' islands.
//   • /api/helpdesk/tickets validates with Zod, fans out notifications to
//     admin users, writes a `helpdesk.ticket_opened` audit row, and rejects
//     other methods.
//   • (authenticated)/layout.tsx mounts <HelpPanel> alongside FTUXTour and
//     AntiDownloadGuard, threading helpdesk contact via props.
//   • All five spec-kit files exist and plan.md follows the
//     CREATED / EDITED / MIGRATED contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const HELP_LIB = "apps/web/src/lib/help.ts";
const PANEL = "apps/web/src/components/help/HelpPanel.tsx";
const TIP = "apps/web/src/components/help/HelpTip.tsx";
const DOT = "apps/web/src/components/help/HelpDot.tsx";
const HEAD = "apps/web/src/components/help/HelpHeadbtn.tsx";
const HOOK = "apps/web/src/components/help/useHelpShortcut.ts";
const TICKETS = "apps/web/src/app/api/helpdesk/tickets/route.ts";
const LAYOUT = "apps/web/src/app/(authenticated)/layout.tsx";
const SPEC_DIR = "specs/122-help-panel-and-dictionary";

test("spec 122 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the help-panel revival spec`,
    );
  }
});

test("spec 122 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(src, /apps\/web\/src\/lib\/help\.ts/, "plan must call out the help dictionary in CREATED");
  assert.match(
    src,
    /apps\/web\/src\/components\/help\/HelpPanel\.tsx/,
    "plan must call out HelpPanel.tsx in CREATED",
  );
  assert.match(
    src,
    /apps\/web\/src\/app\/api\/helpdesk\/tickets\/route\.ts/,
    "plan must call out the helpdesk tickets route in CREATED",
  );
  assert.match(
    src,
    /\(authenticated\)\/layout\.tsx/,
    "plan must call out the layout wiring in EDITED",
  );
});

test("spec 122 — help.ts dictionary carries the full prototype slug set", () => {
  const src = read(HELP_LIB);
  // Top-level objects.
  for (const slug of [
    "school",
    "class",
    "subject",
    "outline",
    "session",
    "teacher",
    "mentor",
    "mentee",
    "pairing",
    "student",
    "resource",
  ]) {
    assert.match(src, new RegExp(`\\b${slug}:`), `HELP must define ${slug}`);
  }
  // Observation internals.
  for (const slug of [
    "observation",
    "cycle",
    "pre_form",
    "post_form",
    "sign_off",
    "baseline",
    "developmental",
    "evaluative",
    "rubric",
  ]) {
    assert.match(src, new RegExp(`\\b${slug}:`), `HELP must define ${slug}`);
  }
  // RTT.
  for (const slug of ["rtt", "phase", "phase_1", "phase_2", "phase_3", "district", "zone", "term", "quarter"]) {
    assert.match(src, new RegExp(`\\b${slug}:`), `HELP must define ${slug}`);
  }
  // Mentorship internals + status pills + video pipeline + auth + roles + fields.
  for (const slug of [
    "feedback_form",
    "commitment",
    "growth_move",
    "strength",
    "status_nominated",
    "status_pre_submitted",
    "status_observed",
    "status_post_submitted",
    "status_complete",
    "status_planned",
    "status_in_progress",
    "watermark",
    "hls",
    "transcoding",
    "whatsapp_ingest",
    "section_gate",
    "audit",
    "confidentiality",
    "role_super_admin",
    "role_programme_admin",
    "role_mentor",
    "role_observer",
    "role_teacher",
    "attendance",
    "cohort",
  ]) {
    assert.match(src, new RegExp(`\\b${slug}:`), `HELP must define ${slug}`);
  }
});

test("spec 122 — help.ts exports the canonical helpers", () => {
  const src = read(HELP_LIB);
  assert.match(src, /export const HELP\s*[:=]/, "must export HELP");
  assert.match(src, /export const HELP_GROUPS/, "must export HELP_GROUPS");
  assert.match(src, /export const HELP_KEYS/, "must export HELP_KEYS");
  assert.match(src, /export function helpFor/, "must export helpFor()");
  assert.match(src, /export function searchHelp/, "must export searchHelp()");
  assert.match(src, /Object\.freeze/, "HELP must be frozen so callers can't mutate the dictionary");
});

test("spec 122 — HelpPanel is a 'use client' island with the canonical surface", () => {
  const src = read(PANEL);
  assert.match(src, /^\s*"use client";/, "HelpPanel must be a client component");
  assert.match(src, /HELP_OPEN_EVENT\s*=\s*["']gml:open-help["']/, "must export the gml:open-help event name");
  assert.match(src, /export function openHelp/, "must export the openHelp() dispatcher");
  assert.match(src, /export function HelpPanel/, "must export the HelpPanel component");
  // The ? keyboard shortcut.
  assert.match(src, /e\.key === ["']\?["']/, "panel must listen for the ? keyboard shortcut");
  // The search input.
  assert.match(src, /searchHelp\(/, "panel must call searchHelp() to filter results");
  // The related-topic chips.
  assert.match(src, /data-help-related/, "panel must mark related-topic chips with data-help-related");
  // The Browse-all grouped list.
  assert.match(src, /HELP_GROUPS/, "panel must iterate HELP_GROUPS for the Browse view");
});

test("spec 122 — HelpPanel wires the three 'Talk to a person' affordances", () => {
  const src = read(PANEL);
  // WhatsApp deep-link.
  assert.match(src, /wa\.me/, "must use wa.me deep-link for the WhatsApp button");
  assert.match(src, /encodeURIComponent/, "must URL-encode the WhatsApp prefill message");
  // mailto deep-link.
  assert.match(src, /mailto:/, "must use mailto: for the email button");
  assert.match(src, /Help:\s*\$\{pageSlug\}/, "mailto subject must include the page slug");
  // Helpdesk POST.
  assert.match(src, /\/api\/helpdesk\/tickets/, "must POST to /api/helpdesk/tickets");
  assert.match(src, /method:\s*["']POST["']/, "ticket button must use POST");
});

test("spec 122 — HelpTip / HelpDot / HelpHeadbtn / useHelpShortcut are client islands", () => {
  for (const path of [TIP, DOT, HEAD, HOOK]) {
    const src = read(path);
    assert.match(src, /^\s*"use client";/, `${path} must be a 'use client' island`);
  }
  // HelpTip + HelpDot + HelpHeadbtn must call openHelp() to bring up the panel.
  for (const path of [TIP, DOT, HEAD]) {
    const src = read(path);
    assert.match(src, /openHelp\(/, `${path} must dispatch via openHelp() to open the panel`);
  }
  // HelpTip carries the dotted-underline affordance.
  assert.match(read(TIP), /textDecorationStyle:\s*["']dotted["']/, "HelpTip must render a dotted underline");
  // HelpDot renders an ⓘ circle with role-correct label.
  assert.match(read(DOT), /aria-label/, "HelpDot must carry an aria-label so it's discoverable to screen readers");
  // INVERTED in the 2026-09 freeze (fix brief D_ui #5). This used to REQUIRE
  // HelpHeadbtn to hardcode the tour anchor. HelpHeadbtn is a per-page-header
  // button, so every page that mounted one would add another element matching
  // the tour's selector, and FTUXTour's querySelector silently takes the first
  // in DOM order. The anchor belongs to the single top-bar HelpButton (see
  // test_123) and, on mobile, the ? FAB.
  assert.doesNotMatch(
    read(HEAD),
    /data-help-anchor=["']topbar-help["']/,
    "HelpHeadbtn must NOT hardcode the topbar-help anchor; the top bar's HelpButton carries it, once",
  );
});

test("spec 122 — the help panel has visible entry points on both shells", () => {
  // It had none: its only trigger was the `?` key, which a phone does not have.
  // The click behaviour is executed in tests/behaviour/ui-navigation.test.ts.
  assert.match(read("apps/web/src/components/nav/Topbar.tsx"), /<HelpButton\b/, "the desktop top bar must render the HelpButton");
  assert.match(read("apps/web/src/components/help/HelpButton.tsx"), /openHelp\(null\)/);
  assert.match(read("apps/web/src/components/MobileHelpFAB.tsx"), /openHelp\(null\)/, "the mobile ? FAB must open the panel");
});

test("spec 122 — /api/helpdesk/tickets validates, audits and rejects other methods", () => {
  const src = read(TICKETS);
  // POST handler + Zod validation.
  assert.match(src, /export async function POST/, "must export a POST handler");
  assert.match(src, /z\.object/, "must validate the body with Zod");
  // Auth gate.
  assert.match(src, /unauthenticated/, "must short-circuit with 'unauthenticated' when no session");
  // Notifications fan-out + admin filter.
  assert.match(src, /notifications/, "must insert into notifications");
  assert.match(src, /helpdesk\.ticket/, "must mark notifications with kind=helpdesk.ticket");
  assert.match(src, /programme_admin/, "must scope recipients to programme_admin (plus super_admin)");
  // Audit row.
  assert.match(src, /helpdesk\.ticket_opened/, "must audit the action as helpdesk.ticket_opened");
  assert.match(src, /recordAudit/, "must use the recordAudit() helper");
  // Other methods are blocked.
  for (const verb of ["GET", "PUT", "DELETE", "PATCH"]) {
    assert.match(src, new RegExp(`export async function ${verb}`), `must export a ${verb} stub returning 405`);
  }
  assert.match(src, /method_not_allowed/, "non-POST handlers must return method_not_allowed");
});

test("spec 122 — (authenticated)/layout.tsx mounts <HelpPanel> globally", () => {
  const src = read(LAYOUT);
  assert.match(src, /from\s+["']@\/components\/help\/HelpPanel["']/, "layout must import HelpPanel");
  assert.match(src, /<HelpPanel/, "layout must render <HelpPanel> at the route-group root");
  // The contact prop is built from the GML_HELPDESK_* variables, THROUGH
  // assertEnv().
  //
  // The old assertions matched the literal strings GML_HELPDESK_PHONE and
  // GML_HELPDESK_EMAIL in the layout's own source. That stopped being the right
  // place to look once the layout started reading them through assertEnv(),
  // which validates them: the names now live in lib/env.ts and the layout's
  // only remaining mention of them was a comment -- so the test was pinning
  // prose, and would have passed just as happily if the comment were the only
  // thing left.
  //
  // Pinned instead: the layout goes through assertEnv(), and lib/env.ts is
  // where the variable names are read. Together that is the same contract,
  // checked where it is actually implemented.
  assert.match(src, /assertEnv\(\)/, "layout must read helpdesk config through assertEnv()");
  assert.match(src, /helpdeskContact/, "layout must lift the contact object into a local const");
  const envSrc = read("apps/web/src/lib/env.ts");
  assert.match(envSrc, /GML_HELPDESK_PHONE/, "lib/env.ts must read GML_HELPDESK_PHONE");
  assert.match(envSrc, /GML_HELPDESK_EMAIL/, "lib/env.ts must read GML_HELPDESK_EMAIL");
});

test("spec 122 — useHelpShortcut hook listens for ? and respects input focus", () => {
  const src = read(HOOK);
  assert.match(src, /export function useHelpShortcut/, "must export the hook");
  assert.match(src, /INPUT|TEXTAREA/, "hook must short-circuit when focus is inside an input/textarea");
  assert.match(src, /e\.key === ["']\?["']/, "hook must listen for ? key");
  assert.match(src, /openHelp\(/, "hook must call openHelp() to keep behaviour aligned with the panel listener");
});

test("spec 122 — HELP_GROUPS exhaustively covers the seven prototype groups", () => {
  const src = read(HELP_LIB);
  for (const id of ["core", "people", "place", "what", "obs", "video", "safe"]) {
    assert.match(src, new RegExp(`id:\\s*["']${id}["']`), `HELP_GROUPS must include group ${id}`);
  }
});

test("spec 122 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [HELP_LIB, PANEL, TIP, DOT, HEAD, HOOK, TICKETS]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/.test(src), `${path} must not contain FIXME markers`);
  }
});
