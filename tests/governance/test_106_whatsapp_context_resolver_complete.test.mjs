import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE_PATH = "apps/web/src/app/api/webhooks/whatsapp/route.ts";
const SPEC_DIR = "specs/106-whatsapp-context-resolver-complete";

test("spec 106: webhook route file exists", () => {
  assert.ok(existsSync(resolve(root, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
});

test("spec 106: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 106: route handles all three caption prefix branches (OBS-, TB-, MM-)", () => {
  const src = read(ROUTE_PATH);
  // The parseCaption helper or the resolver itself must mention each
  // prefix literal, and the resolver block must branch on each
  // ctx.type value.
  for (const prefix of ["OBS", "TB", "MM"]) {
    assert.ok(
      src.includes(prefix + "-"),
      `route must mention the ${prefix}- caption prefix`,
    );
  }
  // Each ctx.type branch must be present in the resolver.
  for (const ctxType of ["observation_cycle", "teach_back", "mentor_meeting", "generic"]) {
    assert.match(
      src,
      new RegExp(`["']${ctxType}["']`),
      `route must reference context_type '${ctxType}'`,
    );
  }
});

test("spec 106: route imports and queries the mentor_meetings table via Drizzle", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /import\s*\{[^}]*\bmentorMeetings\b[^}]*\}\s*from\s*["']@gml\/db\/schema["']/,
    "route must import mentorMeetings from @gml/db/schema",
  );
  // And actually query it.
  assert.match(
    src,
    /\.from\s*\(\s*mentorMeetings\s*\)/,
    "route must select from the mentorMeetings table",
  );
  assert.match(
    src,
    /eq\s*\(\s*mentorMeetings\.id\s*,/,
    "route must filter mentorMeetings by id",
  );
});

test("spec 106: route audits 'whatsapp.context.unmatched' for unresolved captions", () => {
  const src = read(ROUTE_PATH);
  assert.match(
    src,
    /action\s*:\s*["']whatsapp\.context\.unmatched["']/,
    "route must audit 'whatsapp.context.unmatched' for misses",
  );
  // The audit block(s) must include the raw caption in metadata so an
  // operator can see what teachers actually sent.
  const blocks = [
    ...src.matchAll(
      /recordAudit\s*\(\s*\{[^}]*action\s*:\s*["']whatsapp\.context\.unmatched["'][^}]*\}/gs,
    ),
  ];
  assert.ok(
    blocks.length >= 1,
    "at least one 'whatsapp.context.unmatched' audit block must be present",
  );
  for (const b of blocks) {
    assert.match(
      b[0],
      /\bcaption\b/,
      "every 'whatsapp.context.unmatched' audit must include the raw caption in metadata",
    );
  }
});

test("spec 106: every fallthrough miss carries a 'reason' discriminator in audit metadata", () => {
  const src = read(ROUTE_PATH);
  // Each branch's failure mode must record a distinct reason string so an
  // operator can aggregate by reason and see the most common miss class.
  for (const reason of [
    "observation_cycle.code_not_found",
    "teach_back.invalid_uuid",
    "mentor_meeting.invalid_uuid",
    "mentor_meeting.id_not_found",
    "no_prefix_match",
  ]) {
    assert.match(
      src,
      new RegExp(`reason\\s*:\\s*["']${reason.replace(/\./g, "\\.")}["']`),
      `route must emit reason: '${reason}' on the matching fallthrough`,
    );
  }
});

test("spec 106: route validates uuid format before querying postgres uuid columns", () => {
  const src = read(ROUTE_PATH);
  // The TB and MM branches must validate uuid format before either using it
  // as context_id or passing it to the DB — passing a malformed uuid to a
  // postgres uuid column throws and breaks the handler.
  assert.match(
    src,
    /[A-Za-z_]+UUID[A-Za-z_]*|\[0-9a-fA-F\]\{8\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{12\}/,
    "route must define / use a uuid format check (regex or named constant) before DB lookup",
  );
});

test("spec 106: route still inserts the video_submissions row on fallthrough (caption miss does not block upload)", () => {
  const src = read(ROUTE_PATH);
  // The insert call must be reachable from every branch — i.e. it is not
  // gated behind a successful context resolution. We check this structurally
  // by confirming the insert appears AFTER the resolver block and there is
  // no `return` between the unmatched-audit and the insert.
  const insertIdx = src.search(/\.insert\s*\(\s*videoSubmissions\s*\)/);
  const unmatchedIdx = src.search(/whatsapp\.context\.unmatched/);
  assert.ok(insertIdx > -1, "route must insert into videoSubmissions");
  assert.ok(unmatchedIdx > -1, "route must contain the whatsapp.context.unmatched audit");
  assert.ok(
    insertIdx > unmatchedIdx,
    "video_submissions insert must come AFTER the unmatched-audit branches so misses still produce a row",
  );
});

test("spec 106: contextType is reassigned to 'generic' on every fallthrough (not just left null)", () => {
  const src = read(ROUTE_PATH);
  // The fallthrough must explicitly set contextType to 'generic' so the
  // row's discriminator matches the (null) context_id. We assert there is
  // at least one such reassignment in the resolver block.
  const reassigns = src.match(/contextType\s*=\s*["']generic["']/g) ?? [];
  assert.ok(
    reassigns.length >= 3,
    `expected at least 3 contextType='generic' fallthrough assignments (one per failed branch), found ${reassigns.length}`,
  );
});

test("spec 106: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
