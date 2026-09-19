// Governance test for spec 171 — Docs refresh (Workflow Run 16
// audit-closure, docs-only spec).
//
// ── WHY HALF OF THIS FILE IS INVERTED ────────────────────────────────────────
//
// A governance test that pins documentation pins whatever the documentation
// said on the day it was written. When the system moves and the doc does not,
// the test does not catch the drift — it PROTECTS it. This file did exactly
// that: it asserted README-IT.md documented an account lockout policy and a
// self-service password-reset flow, both of which were deleted from the product
// on security grounds. The suite stayed green precisely because the doc was
// wrong, and an operator following it would have run commands that cannot
// execute against services that do not exist.
//
// The assertions below are therefore kept, not deleted, and pointed at the new
// reality with a note on each saying what the old one pinned and where that
// thing went. A doc test is only worth having if failing it means the doc is
// wrong.
//
// Surface area:
//
//   1. README-IT.md — now a SHORT quick reference that defers to
//      README-deploy.md for the full procedure. Two operator documents that
//      overlap will drift, and that drift is what produced this mess.
//
//   2. docs/audit-actions.md — the canonical audit-action taxonomy.
//
//   3. specs/113-docker-compose-boot-smoke/quickstart.md — the four-service
//      boot checklist.
//
//   4. tests/integration/smoke.test.mjs — the post-deploy HTTP probe suite.
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

test("spec 171 — README-IT.md mentions every admin surface an operator needs", () => {
  const src = read(README_PATH);
  // Each admin surface path MUST appear in the README so an IT
  // operator can find it. We pin the literal path strings (not
  // the surrounding prose) so a future copy-edit can't silently
  // drop one of the URLs.
  //
  // /admin/users is NEW to this list. Account creation did not exist at all
  // when the original four were written — the only insert into users anywhere
  // in the repository was the seed, so the only way to onboard a teacher was a
  // hand-written UPDATE against the database. It is now the single most
  // load-bearing surface in the product for an IT operator: it is how accounts
  // are made, how roles are assigned, how people are deactivated, and (since
  // self-service reset is off by default) how a forgotten password is dealt
  // with.
  for (const path of [
    "/admin/users",
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

// ---------- README-IT.md — the account lockout that no longer exists ----------

// INVERTED. This test used to require README-IT.md to document a "5 failed
// login attempts in 1 hour" lockout, a `POST /api/admin/users/[id]/unlock`
// super_admin override, and three `auth.account.*` audit actions.
//
// All of it is gone — the endpoint, the audit actions, and the
// users.failed_login_count / users.locked_until columns that backed the state
// machine (see packages/db/src/schema/identity.ts). It was deleted because it
// was a denial-of-service tool in BOTH directions:
//
//   • Anyone who knew an address could lock that account at will by submitting
//     five wrong passwords. No authentication required, no cost to the
//     attacker. Locking a programme administrator out during a deploy took
//     five HTTP requests.
//   • The counter never decayed. After the hour expired the account was
//     unlocked but still sitting at five failures, so ONE further wrong guess
//     re-locked it for another hour — an indefinite lockout sustained at one
//     request per hour.
//   • The distinct "account is locked" error was an account-existence oracle:
//     it answered "does this address have an account here" for free.
//
// Supabase Auth rate-limits sign-in centrally now, with no per-account flag a
// stranger can set on somebody else's behalf. The operator remedy for a user
// who cannot get in is to set them a new password at /admin/users.
//
// So the assertion flips: the README must NOT resurrect any of this. Pinning
// absence is what stops the next person restoring the section from an old copy
// of the file — which is a live risk, since the deleted text reads like a
// perfectly reasonable security control.
test("spec 171 — README-IT.md does not resurrect the deleted account-lockout policy", () => {
  const src = read(README_PATH);

  // The endpoint was deleted. Confirm that at the filesystem, not just in
  // prose, so this test fails if somebody re-adds the route as well as if
  // somebody re-adds the paragraph.
  assert.ok(
    !existsSync(resolve(root, "apps/web/src/app/api/admin/users/[id]/unlock")),
    "the unlock endpoint must stay deleted — it existed to undo a lockout any " +
      "stranger could impose, and the lockout itself is gone",
  );
  assert.ok(
    !/\/api\/admin\/users\/\[id\]\/unlock/.test(src),
    "README-IT.md must not document the unlock endpoint — it does not exist, and an " +
      "operator who tries it gets a 404 at the moment they most need it to work",
  );

  // The threshold and duration. README-IT.md explains in prose that there is no
  // per-account lockout; what it must not do is state a policy with numbers,
  // because a number in an operator doc reads as a contract.
  assert.ok(
    !/5\s+failed\s+login\s+attempts/i.test(src),
    "README-IT.md must not state a failed-attempt threshold — there is no per-account " +
      "counter any more, so any number here is fiction",
  );

  // The three audit actions. Verified absent from shipped code first, so this
  // is pinning a real property and not merely doc hygiene.
  for (const action of [
    "auth.account.locked",
    "auth.account.locked_attempt",
    "auth.account.unlocked",
  ]) {
    assert.ok(
      !new RegExp(action.replace(/\./g, "\\.")).test(src),
      `README-IT.md must not list the \`${action}\` audit action — nothing emits it, so an ` +
        `operator grepping the audit log for it finds nothing and concludes the log is broken`,
    );
  }

  // And the replacement must actually be documented, or removing the section
  // just leaves a hole where an operator's question used to be answered.
  assert.match(
    src,
    /\/admin\/users/,
    "README-IT.md must point at /admin/users as the remedy for a user who cannot sign in",
  );
  assert.match(
    src,
    /supabase\s+auth\s+rate[- ]limits/i,
    "README-IT.md must say where sign-in rate limiting lives now (Supabase Auth, centrally) — " +
      "otherwise the doc reads as though nothing protects the login path at all",
  );
});

// ---------- README-IT.md — password resets go through an administrator ----------

// INVERTED. This test used to require README-IT.md to document a self-service
// reset flow: a token minted at /login/forgot with a 30-minute TTL, a row in
// password_reset_tokens, a 3-per-hour-per-IP rate limit, and SMTP_HOST as the
// env flag that switched the whole thing on.
//
// Two separate things changed, and the test has to follow both.
//
//   1. The IMPLEMENTATION was deleted. /api/auth/reset-password took the
//      submitted token and bcrypt-compared it against EVERY live row in
//      password_reset_tokens — an O(N) bcrypt loop on an anonymous endpoint
//      with no rate limit in front of it. That is a CPU-exhaustion primitive
//      handed to the internet: one unauthenticated request could pin a core,
//      and the "3 per hour" limit this test pinned lived on a different
//      endpoint. Recovery is Supabase's now. The table is gone too.
//
//   2. The FLAG moved, and it had to. SMTP_HOST was the application's own
//      environment variable. Under Supabase, SMTP is configured in the
//      dashboard — so SMTP_HOST can be unset on a deployment where email works
//      perfectly, and set on one where it does not. It is simply the wrong
//      signal. AUTH_EMAIL_ENABLED is an explicit statement of intent instead,
//      and it defaults to `false` because attaching a relay has been deferred
//      to IT.
//
// While it is false the honest operator-facing fact is that an administrator
// sets passwords at /admin/users and hands them over. That is what the README
// must say. Documenting a token TTL for a token nobody mints would send an
// operator hunting for an email that was never going to be sent.
test("spec 171 — README-IT.md documents administrator-set passwords, not the deleted token flow", () => {
  const src = read(README_PATH);

  // The endpoint and its whole route segment are gone. Pin that at the
  // filesystem so re-adding the route fails here too, not just re-adding prose.
  assert.ok(
    !existsSync(resolve(root, "apps/web/src/app/api/auth/reset-password")),
    "the self-service reset endpoint must stay deleted — it bcrypt-compared a submitted " +
      "token against every live token row, unauthenticated and unthrottled",
  );

  for (const [needle, why] of [
    [
      /\/api\/auth\/reset-password/,
      "the endpoint does not exist; documenting it points an operator at a 404",
    ],
    [
      /password_reset_tokens/,
      "the table was dropped with the flow it backed",
    ],
    [
      /30\s*min/i,
      "there is no token TTL to state — no token of ours is minted any more",
    ],
    [
      /3\s*(?:per|\/|\s+requests?\s+per)\s*hour/i,
      "that rate limit belonged to the deleted endpoint",
    ],
    [
      /SMTP_HOST/,
      "SMTP_HOST is the wrong signal under Supabase — mail is configured in the " +
        "dashboard, so the variable can be unset where email works and set where it does not",
    ],
  ]) {
    assert.ok(!needle.test(src), `README-IT.md must not mention ${needle} — ${why}`);
  }

  // The replacement, which is the part an operator actually has to act on.
  assert.match(
    src,
    /AUTH_EMAIL_ENABLED/,
    "README-IT.md must name AUTH_EMAIL_ENABLED — it is the flag that decides whether the " +
      "reset page shows a form or tells the user to contact an administrator",
  );
  assert.match(
    src,
    /supabase\s+dashboard/i,
    "README-IT.md must say SMTP is configured in the Supabase dashboard, not in this " +
      "application — otherwise IT goes looking for an SMTP block in .env that is not there",
  );
  assert.match(
    src,
    /\/admin\/users/,
    "README-IT.md must name /admin/users as where an administrator sets a password while " +
      "self-service reset is off",
  );
});

// ---------- README-IT.md — env table extension ----------

// RE-POINTED. The property is unchanged and still matters: an operator copying
// this table into Ansible or Salt must see the whole env surface. One entry had
// to move, though — MINIO_BUCKET named the bucket for video originals and HLS
// renditions on a MinIO that no longer exists in this stack, and nothing reads
// the variable. Leaving it pinned would have kept a dead key in an operator doc
// forever. It is replaced here by the keys that actually gate the deployment:
// the Supabase credentials the stack refuses to start without, and
// AUTH_EMAIL_ENABLED, which decides what the password-reset page does.
test("spec 171 — README-IT.md env table covers the keys an operator must set", () => {
  const src = read(README_PATH);
  for (const key of [
    "DATABASE_URL",
    "SUPABASE_SECRET_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "AUTH_EMAIL_ENABLED",
    "WORKER_CONCURRENCY",
    "TZ",
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

  // Dead keys are worse than missing ones: an operator who sets MINIO_BUCKET
  // believes they have configured object storage, and nothing tells them
  // otherwise until a video fails to play.
  assert.ok(
    !/\bMINIO_[A-Z_]+\b/.test(src),
    "README-IT.md must not list MinIO variables — no service reads them and no MinIO runs " +
      "in this stack",
  );
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

// ---------- tests/integration/smoke.test.mjs — coverage and failure mode ----------

/**
 * Strip comments so an absence assertion cannot be defeated by the comment that
 * explains the absence. Only FULL-LINE `//` comments are removed: a trailing
 * strip would also cut `"http://localhost:3000"` in half at the `//`, which is
 * the sort of thing that makes a governance test quietly stop testing anything.
 */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// INVERTED. This used to count `fetch(BASE + ...)` call sites and require at
// least 12 — an 8-probe spec-111 baseline plus 4 added for run 16. The suite
// has been rewritten and no longer spells its probes that way: it routes
// everything through one `get(path)` helper that applies a bounded timeout,
// because a hung probe is a failed probe and the old call sites had no timeout
// at all.
//
// Counting call sites was never the point; counting COVERAGE was. So this now
// counts distinct paths the suite actually probes, which is the property the
// original number was a proxy for, and it no longer breaks when somebody
// factors the fetch call into a helper.
test("spec 171 — the post-deploy smoke suite probes the real surface", () => {
  const src = code(read(SMOKE_PATH));

  const paths = [...new Set((src.match(/"\/[^"\s]*"/g) ?? []).map((s) => s.slice(1, -1)))];
  assert.ok(
    paths.length >= 12,
    `tests/integration/smoke.test.mjs must probe at least 12 distinct paths (found ` +
      `${paths.length}: ${paths.join(", ")}). A post-deploy check that touches one or two ` +
      `endpoints tells you the process is listening, not that the deployment works.`,
  );

  // The load-bearing ones, named. A deploy that passes smoke without having
  // exercised these has not been checked in any useful sense.
  for (const path of ["/api/health", "/login", "/dashboard", "/api/webhooks/whatsapp"]) {
    assert.ok(
      paths.includes(path),
      `the smoke suite must probe ${path}`,
    );
  }
});

// INVERTED, and this is the important one. The old assertion required four
// probes named "smoke 9".."smoke 12" and a helper called skipIfUnreachable(t),
// whose entire job was to SKIP the suite when the application could not be
// reached. CI then ran the suite with `|| true` on top of that.
//
// `node --test` exits 0 when everything skips. The suite was therefore
// structurally incapable of failing: it reported green whether the deployment
// worked or not, and it did so for its entire life. That is precisely the
// defect this governance directory has one layer up — assertions that cannot
// observe the thing they claim to protect.
//
// The suite now FAILS when it cannot reach the target, and scripts/deploy.sh
// runs it (step 6) against the deployment it has just made, where a full stack
// genuinely exists. CI's executable coverage moved to `pnpm test:behaviour`,
// which runs against a real Postgres service container and does not need a
// booted application. Its old assertions were substantively wrong as well: it
// probed Auth.js endpoints that no longer exist and asserted a /api/health
// shape carrying `redis` and `minio` keys that went with the services.
//
// So: pin the absence of the skip path, and pin the loud failure that replaced
// it. Re-adding a skip guard to make a red suite green must fail here.
test("spec 171 — the smoke suite fails when unreachable instead of skipping", () => {
  const src = code(read(SMOKE_PATH));

  for (const token of ["skipIfUnreachable", ".skip(", "skip:", "t.skip"]) {
    assert.ok(
      !src.includes(token),
      `tests/integration/smoke.test.mjs must not contain \`${token}\` — a suite that skips ` +
        `itself when the app is unreachable exits 0 and reports green on a deployment that ` +
        `never came up. That is the exact failure this file was rewritten to end.`,
    );
  }

  assert.match(
    src,
    /assert\.fail\(/,
    "the unreachable case must be a hard failure — assert.fail(), not a skip and not a return",
  );
  assert.match(
    src,
    /test\("the deployment is reachable"/,
    "the reachability check must be the first test and must be a test, so its failure is " +
      "attributable rather than showing up as ten confusing downstream errors",
  );

  // The health-shape regression the rewrite closed, pinned so it cannot come
  // back: `redis` and `minio` were removed from the response AND from the `ok`
  // AND-chain, and the endpoint now answers 503 rather than 200-with-ok:false.
  assert.match(
    src,
    /for\s*\(const gone of \["redis", "minio"\]\)/,
    "the smoke suite must assert /api/health does NOT report `redis` or `minio` — a probe " +
      "for a service that no longer exists would report false forever and pin the endpoint " +
      "at 503, taking the container healthcheck and the deploy readiness wait down with it",
  );
  assert.match(
    src,
    /body\.ok \? 200 : 503/,
    "the smoke suite must assert the status code matches the body — /api/health used to " +
      "return 200 with ok:false, so every probe that reads only the status code was decorative",
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
