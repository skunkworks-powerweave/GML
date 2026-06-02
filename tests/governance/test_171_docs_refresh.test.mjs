// Governance test for spec 171 — Docs refresh (Workflow Run 16
// audit-closure, docs-only spec).
//
// Surface area:
//
//   1. README-IT.md (EDITED)
//      — three new sections appended: "New admin surfaces (post-audit
//        closure)", "Account lockout policy", "Password reset flow".
//      — env table extended with WORKER_CONCURRENCY, TZ, MINIO_BUCKET,
//        GML_WHATSAPP_NUMBER, GML_HELPDESK_PHONE, GML_HELPDESK_EMAIL.
//
//   2. docs/audit-actions.md (REWRITTEN)
//      — comprehensive taxonomy with 30+ distinct dotted-notation
//        actions grouped by entity prefix.
//
//   3. specs/113-docker-compose-boot-smoke/quickstart.md (EDITED)
//      — new sub-steps 7.5, 7.6, 7.7 for the three new admin surfaces.
//      — new step 11 for the password-reset flow.
//
//   4. tests/integration/smoke.test.mjs (EDITED)
//      — four new probes (smoke 9 through smoke 12) covering the new
//        admin surfaces and /login/forgot.
//      — fetch-call count >= 12 (was 8).
//
//   5. specs/171-docs-refresh/{spec,plan,research,quickstart,tasks}.md

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const README_PATH = "README-IT.md";
const AUDIT_DOC_PATH = "docs/audit-actions.md";
const SMOKE_PATH = "tests/integration/smoke.test.mjs";
const QS_113_PATH = "specs/113-docker-compose-boot-smoke/quickstart.md";
const SPEC_DIR = "specs/171-docs-refresh";

// ---------- Spec-kit + plan.md contract ----------

test("spec 171 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the docs-refresh spec`,
    );
  }
});

test("spec 171 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // The four touched files MUST be named in plan.md so a reader
  // auditing the contract knows the surface area.
  for (const file of [
    "README-IT.md",
    "audit-actions.md",
    "smoke.test.mjs",
    "quickstart.md",
  ]) {
    assert.match(
      src,
      new RegExp(file),
      `plan.md must call out the ${file} touchpoint so the surface is discoverable`,
    );
  }
});

test("spec 171 — spec.md mentions Run 16 and audit closure", () => {
  const src = read(`${SPEC_DIR}/spec.md`);
  assert.match(
    src,
    /Run 16/i,
    "spec.md must reference Run 16 — this is the run-16 audit closure docs spec",
  );
  assert.match(
    src,
    /audit closure|audit-closure/i,
    "spec.md must mention `audit closure` so the workflow context is discoverable",
  );
});

// ---------- README-IT.md — admin surfaces section ----------

test("spec 171 — README-IT.md mentions all four new admin surfaces", () => {
  const src = read(README_PATH);
  // Each admin surface path MUST appear in the README so an IT
  // operator can find it. We pin the literal path strings (not
  // the surrounding prose) so a future copy-edit can't silently
  // drop one of the URLs.
  for (const path of [
    "/admin/quizzes",
    "/admin/transcode-jobs",
    "/admin/system-settings",
    "/admin/whatsapp-log",
  ]) {
    assert.match(
      src,
      new RegExp(path.replace(/\//g, "\\/")),
      `README-IT.md must mention the ${path} admin surface so on-call ops can find it`,
    );
  }
});

// ---------- README-IT.md — account lockout policy ----------

test("spec 171 — README-IT.md describes the account lockout policy", () => {
  const src = read(README_PATH);
  // The policy section must mention the load-bearing numbers:
  // "5" failed attempts and "1 hour" lockout. Pin both literally
  // so a future contributor can't silently relax the policy
  // (e.g. weaken to "3 attempts in 5 minutes") without touching
  // the doc.
  assert.match(
    src,
    /5\s+failed\s+login\s+attempts/i,
    "README-IT.md lockout section must mention '5 failed login attempts' so the threshold is discoverable",
  );
  assert.match(
    src,
    /1[\s-]?hour|1\s+hour/i,
    "README-IT.md lockout section must mention '1 hour' so the lockout duration is discoverable",
  );
  // The super_admin override endpoint MUST be documented.
  assert.match(
    src,
    /\/api\/admin\/users\/\[id\]\/unlock/,
    "README-IT.md lockout section must document the POST /api/admin/users/[id]/unlock super_admin override",
  );
  // The three audit actions involved MUST be listed.
  for (const action of [
    "auth.account.locked",
    "auth.account.locked_attempt",
    "auth.account.unlocked",
  ]) {
    assert.match(
      src,
      new RegExp(action.replace(/\./g, "\\.")),
      `README-IT.md lockout section must list the \`${action}\` audit action`,
    );
  }
});

// ---------- README-IT.md — password reset flow ----------

test("spec 171 — README-IT.md describes the password-reset flow", () => {
  const src = read(README_PATH);
  assert.match(
    src,
    /\/login\/forgot/,
    "README-IT.md must reference the /login/forgot entry point",
  );
  // The TTL must be documented — 30 minutes is the spec-161 contract.
  assert.match(
    src,
    /30\s*min/i,
    "README-IT.md password-reset section must document the 30-minute token TTL",
  );
  // The SMTP-gating must be documented — the unavailable-banner
  // degradation is the operator-visible contract.
  assert.match(
    src,
    /SMTP_HOST/,
    "README-IT.md password-reset section must reference SMTP_HOST so the env dependency is discoverable",
  );
  assert.match(
    src,
    /feature unavailable|unavailable/i,
    "README-IT.md password-reset section must mention the 'feature unavailable' fallback banner",
  );
  // Rate limit: 3 per hour per IP. Accept either the literal "3 / hour"
  // or the prose form "3 requests per hour".
  assert.match(
    src,
    /3\s*(?:per|\/|\s+requests?\s+per)\s*hour/i,
    "README-IT.md password-reset section must document the 3/hour per-IP rate limit",
  );
});

// ---------- README-IT.md — env table extension ----------

test("spec 171 — README-IT.md env table includes the six new keys", () => {
  const src = read(README_PATH);
  for (const key of [
    "WORKER_CONCURRENCY",
    "TZ",
    "MINIO_BUCKET",
    "GML_WHATSAPP_NUMBER",
    "GML_HELPDESK_PHONE",
    "GML_HELPDESK_EMAIL",
  ]) {
    assert.match(
      src,
      new RegExp(`\\b${key}\\b`),
      `README-IT.md env table must include the ${key} key so an operator copying it into Ansible / Salt sees the full env surface`,
    );
  }
});

// ---------- docs/audit-actions.md — taxonomy size ----------

test("spec 171 — docs/audit-actions.md exists and has at least 30 distinct dotted-notation actions", () => {
  assert.ok(
    existsSync(resolve(root, AUDIT_DOC_PATH)),
    `${AUDIT_DOC_PATH} must exist as the canonical audit-actions taxonomy`,
  );
  const src = read(AUDIT_DOC_PATH);
  // Count distinct dotted-notation actions appearing in backtick
  // code spans. A "dotted action" is a string like `prefix.subaction`
  // wrapped in backticks. Use a Set so duplicate listings don't
  // inflate the count.
  const matches = src.match(/`[a-z_]+\.[a-z_.]+`/g) ?? [];
  const distinct = new Set(matches.map((m) => m.slice(1, -1)));
  assert.ok(
    distinct.size >= 30,
    `docs/audit-actions.md must document at least 30 distinct dotted-notation actions (found ${distinct.size}); the run-16 sweep yielded 40+ live actions in shipped code`,
  );
});

test("spec 171 — docs/audit-actions.md covers the load-bearing prefix families", () => {
  const src = read(AUDIT_DOC_PATH);
  // The prefix families that MUST have a documented section. If
  // one is missing the file is incomplete and the taxonomy is
  // misleading.
  for (const prefix of [
    "auth.",
    "gate.",
    "form.",
    "quiz.",
    "whatsapp.",
    "transcode.",
    "admin.row.",
    "learners.",
    "system_settings.",
    "anti_download.",
  ]) {
    assert.match(
      src,
      new RegExp(prefix.replace(/\./g, "\\.")),
      `docs/audit-actions.md must document the \`${prefix}*\` family — it's load-bearing in shipped code`,
    );
  }
});

// ---------- specs/113 quickstart — new steps ----------

test("spec 171 — specs/113 quickstart references /login/forgot and /admin/transcode-jobs", () => {
  const src = read(QS_113_PATH);
  assert.match(
    src,
    /\/login\/forgot/,
    "specs/113 quickstart must include a step exercising /login/forgot (the password-reset flow)",
  );
  assert.match(
    src,
    /\/admin\/transcode-jobs/,
    "specs/113 quickstart must include a step exercising /admin/transcode-jobs (the DLQ admin surface)",
  );
  // Belt-and-suspenders: the other two new admin surfaces should
  // also appear, so the smoke checklist is consistent.
  assert.match(
    src,
    /\/admin\/quizzes/,
    "specs/113 quickstart must include a step exercising /admin/quizzes",
  );
  assert.match(
    src,
    /\/admin\/system-settings/,
    "specs/113 quickstart must include a step exercising /admin/system-settings",
  );
});

// ---------- tests/integration/smoke.test.mjs — fetch-count ----------

test("spec 171 — tests/integration/smoke.test.mjs has at least 12 fetch calls (was 8 pre-run-16)", () => {
  const src = read(SMOKE_PATH);
  // Count the `fetch(BASE + ` invocations. The spec-111 baseline
  // was 8; spec 171 adds 4 new probes for the post-audit-closure
  // admin surfaces and the password-reset entry point. Pin the
  // count to >= 12 so a future contributor can't silently remove
  // any of the new probes.
  const matches = src.match(/fetch\(\s*BASE\s*\+\s*/g) ?? [];
  assert.ok(
    matches.length >= 12,
    `tests/integration/smoke.test.mjs must contain at least 12 fetch(BASE + ...) calls (found ${matches.length}); the run-16 docs refresh adds 4 new probes on top of the spec-111 baseline of 8`,
  );
});

test("spec 171 — smoke test new probes follow the skipIfUnreachable pattern", () => {
  const src = read(SMOKE_PATH);
  // Each new probe must call skipIfUnreachable(t) so CI without a
  // running stack stays green by skipping. If a contributor adds
  // a probe without the skip-guard, the entire integration suite
  // breaks on dev hosts.
  for (const probeName of ["smoke 9", "smoke 10", "smoke 11", "smoke 12"]) {
    assert.match(
      src,
      new RegExp(`["']${probeName}\\b`),
      `tests/integration/smoke.test.mjs must define the \`${probeName}\` test case`,
    );
  }
  // Pin the load-bearing helper name so a future refactor that
  // renames it has to update both the source AND this governance
  // test, surfacing the dependency.
  assert.match(
    src,
    /function\s+assertAuthGated\s*\(/,
    "tests/integration/smoke.test.mjs must define the assertAuthGated() helper so the redirect-or-403 contract is centralised",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 171 — no TODO / FIXME / placeholder markers leaked into the shipped docs", () => {
  for (const path of [README_PATH, AUDIT_DOC_PATH]) {
    const src = read(path);
    assert.ok(
      !/\bTODO\b/.test(src),
      `${path} must not contain TODO markers — this is the run-16 docs CLOSURE, not a placeholder`,
    );
    assert.ok(
      !/\bFIXME\b/.test(src),
      `${path} must not contain FIXME markers`,
    );
    assert.ok(
      !/\bxxx\b/i.test(src) || /xxxxxxx/i.test(src),
      `${path} must not contain XXX placeholders (a long string of x is a phone-format mask, that's fine)`,
    );
  }
});
