// Governance test — the Graph API version the WhatsApp webhook calls.
//
// ── THE DEFECT THIS EXISTS TO CATCH ──────────────────────────────────────────
//
// apps/web/src/app/api/webhooks/whatsapp/route.ts called
// `https://graph.facebook.com/v19.0/{media-id}` with the version written into
// the URL literal. Meta's published version table gives v19.0 a release date of
// 2024-01-23 and an EXPIRATION of 2026-05-21 — four months before this test was
// written. The call had been aimed at an expired version and nothing said so.
//
// WHY IT COULD NOT HAVE BEEN NOTICED. Meta does not fail a call to an expired
// version; per its versioning guide the request is silently served by the
// next-oldest usable version. Downstream, `fetchMediaUrl` returns null on any
// non-OK response, the caller drops the media, and the webhook still answers
// Meta with HTTP 200. So every failure mode on this path — expired version,
// blank access token, revoked token — produces exactly the same observable
// result as "no video was sent": nothing.
//
// This file pins two things that are cheap to check statically and would each
// have caught it:
//
//   1. the version is not written into a URL literal anywhere in the app, so
//      there is one place to change and one place to review; and
//   2. the pinned version has not passed its published expiry date.
//
// ── ON PURPOSE: THIS TEST HAS AN EXPIRY DATE ─────────────────────────────────
//
// Assertion 2 compares against the real clock, so this suite WILL go red on
// 2028-07-29 if nobody has bumped the pin by then. That is the point and it is
// not an accident: a silent expiry is what produced the defect, and a test that
// cannot fail on a date cannot catch a date-triggered defect. It fails loudly,
// in CI, with a message naming the next version and the table to read — which
// is a far better morning than discovering that media ingest has been quietly
// degrading. GRACE_DAYS makes it fail BEFORE the cliff rather than on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const readText = (rel) => readFileSync(resolve(root, rel), "utf8");

/**
 * Source with // and block comments removed.
 *
 * The suite's standing convention, and this file needed it immediately: the
 * shared module's own docblock QUOTES the defective URL
 * (`https://graph.facebook.com/v19.0/{media-id}`) in order to explain what went
 * wrong, and without this the rule below would forbid a file from documenting
 * the bug it fixes. A comment naming a call is not a call.
 */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, "");

const GRAPH_MODULE = "packages/shared/src/whatsapp/graph.ts";
const ROUTE = "apps/web/src/app/api/webhooks/whatsapp/route.ts";

/**
 * Meta's published version table, transcribed 2026-09-24 from
 * https://developers.facebook.com/docs/graph-api/changelog/versions
 *
 * `null` expiry means Meta has not published one yet, which is normal for the
 * newest release and is NOT treated as "never expires" — it is treated as
 * "unknown", and the pin policy below prefers a version with a committed
 * support window over one without.
 */
const META_VERSIONS = {
  "v19.0": { released: "2024-01-23", expires: "2026-05-21" },
  "v20.0": { released: "2024-05-21", expires: "2026-09-24" },
  "v21.0": { released: "2024-10-02", expires: "2027-01-21" },
  "v22.0": { released: "2025-01-21", expires: "2027-05-20" },
  "v23.0": { released: "2025-05-29", expires: "2027-10-08" },
  "v24.0": { released: "2025-10-08", expires: "2028-02-18" },
  "v25.0": { released: "2026-02-18", expires: "2028-07-29" },
  "v26.0": { released: "2026-07-29", expires: null },
};

/** Fail this many days BEFORE the expiry, so the bump is planned, not urgent. */
const GRACE_DAYS = 90;

/** The version string the shared module pins, read out of its source. */
function pinnedVersion() {
  const src = readText(GRAPH_MODULE);
  const m = /DEFAULT_GRAPH_API_VERSION\s*=\s*"(v\d+\.\d+)"/.exec(src);
  assert.ok(
    m,
    `${GRAPH_MODULE} must declare DEFAULT_GRAPH_API_VERSION = "vNN.N" so there is exactly ` +
      `one place the pinned version lives and one place a reviewer has to look`,
  );
  return m[1];
}

test("173. the Graph API version is not written into a URL literal", () => {
  // The defect in its original form: a version baked into the fetch URL, seven
  // majors and two expiries out of date, with nothing to grep for at review.
  for (const rel of [ROUTE, GRAPH_MODULE]) {
    // `.exec()[0]`, not the match object: assert.equal on a match ARRAY prints
    // the array's `input` property, which is the entire source file, and buries
    // the message this assertion exists to deliver.
    const literal = /graph\.facebook\.com\/v\d+\.\d+/.exec(code(readText(rel)))?.[0];
    assert.equal(
      literal,
      undefined,
      `${rel} builds a graph.facebook.com URL with the version written into it ` +
        `(found "${literal}"). Build it from DEFAULT_GRAPH_API_VERSION in ${GRAPH_MODULE} ` +
        `instead, so the next expiry is a one-line change and not a grep.`,
    );
  }
});

test("173. the app has exactly one Graph API call site, and it is the shared one", () => {
  // If a second call site appears with its own version, assertion 1 above stops
  // meaning what it says — so the count is pinned too.
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
        walk(rel);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      if (/graph\.facebook\.com/.test(code(readText(rel)))) hits.push(rel);
    }
  };
  for (const top of ["apps", "packages"]) walk(top);

  assert.deepEqual(
    hits.sort(),
    [GRAPH_MODULE],
    `graph.facebook.com must appear in exactly one source file (${GRAPH_MODULE}); found: ${hits.join(", ") || "none"}`,
  );
});

test("173. the pinned Graph API version is one Meta actually publishes", () => {
  const pinned = pinnedVersion();
  assert.ok(
    Object.hasOwn(META_VERSIONS, pinned),
    `${pinned} is not in the transcribed version table. Either it is a typo, or the table ` +
      `in this test is stale — re-read ` +
      `https://developers.facebook.com/docs/graph-api/changelog/versions and update it here.`,
  );
});

test("173. the pinned Graph API version has not expired", () => {
  // The canary. It compares against the real clock deliberately; see the header.
  const pinned = pinnedVersion();
  const { expires } = META_VERSIONS[pinned] ?? {};
  if (expires === null) return; // newest release, no published expiry yet

  const deadline = Date.parse(`${expires}T00:00:00Z`) - GRACE_DAYS * 86_400_000;
  const now = Date.now();

  const alternatives = Object.entries(META_VERSIONS)
    .filter(([, v]) => v.expires === null || Date.parse(`${v.expires}T00:00:00Z`) > now)
    .map(([k]) => k);

  assert.ok(
    now < deadline,
    `Graph API ${pinned} expires ${expires} (Meta's published table), which is now less than ` +
      `${GRACE_DAYS} days away or already past.\n` +
      `Meta does NOT fail a call to an expired version — it silently serves it from the ` +
      `next-oldest usable version — so this will not show up as an error anywhere.\n` +
      `Bump DEFAULT_GRAPH_API_VERSION in ${GRAPH_MODULE} and re-transcribe META_VERSIONS in ` +
      `this file from https://developers.facebook.com/docs/graph-api/changelog/versions\n` +
      `Versions still current per the transcribed table: ${alternatives.join(", ")}`,
  );
});

test("173. the version is overridable by environment, with a default", () => {
  // An expiry should be survivable without a deploy of new code: the operator
  // sets one variable. The default still has to exist, because a deployment
  // that forgets the variable must call a real version rather than "undefined".
  const src = code(readText(GRAPH_MODULE));
  assert.match(
    src,
    /WHATSAPP_GRAPH_API_VERSION/,
    `${GRAPH_MODULE} must allow WHATSAPP_GRAPH_API_VERSION to override the pin`,
  );
  // Asserted on the NAME, not on `process.env.NAME`: the module takes the
  // environment as a defaulted parameter so it can be exercised without mutating
  // the real process. The first version of this assertion required the literal
  // `process.env.` spelling and would have failed that better design — a
  // governance test pinning an implementation detail instead of a property.
  assert.match(
    src,
    /DEFAULT_GRAPH_API_VERSION/,
    `${GRAPH_MODULE} must fall back to DEFAULT_GRAPH_API_VERSION when the variable is unset`,
  );
});

test("173. packages/shared does not reach for Node-only globals", () => {
  // ── THE DEFECT THIS CATCHES, WHICH CI CAUGHT FIRST ────────────────────────
  //
  // The first version of the shared module typed its parameter as
  // `NodeJS.ProcessEnv` and defaulted it to `process.env`. packages/shared
  // declares no @types/node dependency and no other file in it referenced a
  // Node global, so this was the first one. It typechecked on the machine it
  // was written on -- where @types/node is reachable through the pnpm store --
  // and failed CI on a clean install:
  //
  //   error TS2503: Cannot find namespace 'NodeJS'.
  //   error TS2591: Cannot find name 'process'.
  //
  // Declaring @types/node here would silence it and be wrong: this package is
  // imported by apps/web including code that reaches the browser, where there
  // is no process. A shared package asserting a Node runtime in its TYPES is
  // making a claim about every consumer of it.
  //
  // Checked on comment-stripped source, so the module can explain the defect
  // in prose without tripping the rule that forbids it.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const src = code(readText(rel));
      // `NodeJS.` is the namespace; the second pattern is a BARE `process.`,
      // which excludes the deliberate `(globalThis as {...}).process?.env`
      // because that one is preceded by a dot.
      const bad =
        /\bNodeJS\./.exec(src)?.[0] ??
        /(?:^|[^.\w])(process\s*\.)/m.exec(src)?.[1];
      if (bad) offenders.push(`${rel} (${bad.trim()})`);
    }
  };
  walk("packages/shared/src");

  assert.deepEqual(
    offenders,
    [],
    `packages/shared declares no @types/node and is imported by browser-bound code, so it ` +
      `cannot reference Node-only globals. Reach the environment through ` +
      `globalThis, or take it as a parameter. Offenders: ${offenders.join(", ")}`,
  );
});

test("173. the override variable is documented and plumbed into the container", () => {
  // The failure this prevents is the one .env.example already has elsewhere: a
  // variable the code reads that an operator has no way to discover.
  assert.match(
    readText(".env.example"),
    /^#?\s*WHATSAPP_GRAPH_API_VERSION=/m,
    ".env.example must list WHATSAPP_GRAPH_API_VERSION so an operator can find it",
  );
  assert.match(
    readText("docker-compose.yml"),
    /WHATSAPP_GRAPH_API_VERSION:/,
    "docker-compose.yml must forward WHATSAPP_GRAPH_API_VERSION to the app service, or setting " +
      "it in .env would have no effect on the running container",
  );
});
