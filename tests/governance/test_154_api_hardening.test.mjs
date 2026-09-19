// Governance test for spec 154 — API hardening (Workflow Run 14
// audit-closure MEDIUM).
//
// Three route handlers under audit:
//
//   1. apps/web/src/app/api/uploads/tus/route.ts (EDITED)
//      — every method handler (GET / POST / HEAD / PATCH / DELETE)
//        now gates on `auth()` via a `requireAuth()` helper and
//        early-returns 401 on missing session;
//      — the 501 response body contains neither the env var name
//        `TUSD_INTERNAL_URL` nor the string `hint`;
//      — the diagnostic is logged via `console.warn` instead.
//
//   2. apps/web/src/app/api/form-drafts/[id]/route.ts (EDITED)
//      — the PUT handler's silent `req.json().catch(() => ({}))`
//        is replaced with an explicit try/catch that returns 400
//        `{ error: "invalid_json", message: String(err) }`.
//
//   3. apps/web/src/app/api/helpdesk/tickets/route.ts (EDITED)
//      — imports `rateLimit` from `@/lib/rate-limit`;
//      — throttles ticket creation at 5 per user per 60 minutes;
//      — on limit-hit returns 429 with `Retry-After` and audits
//        `helpdesk.ticket_rate_limited`;
//      — on Redis fault logs and falls through (fail-open).
//
// Plus the five spec-kit files under specs/154-api-hardening/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const TUS_PATH = "apps/web/src/app/api/uploads/tus/route.ts";
// Where the upload lifecycle lives now that the tusd proxy is gone: two server
// actions that bracket a direct browser -> Storage transfer.
const UPLOAD_ACTIONS_PATH = "apps/web/src/app/(authenticated)/uploads/actions.ts";
const UPLOAD_LIB_PATH = "apps/web/src/lib/video/upload.ts";
const FORM_DRAFT_PATH = "apps/web/src/app/api/form-drafts/[id]/route.ts";
const HELPDESK_PATH = "apps/web/src/app/api/helpdesk/tickets/route.ts";
const SPEC_DIR = "specs/154-api-hardening";

/** Comments stripped, so prose explaining a removal cannot fail an absence check. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---------- Spec-kit + plan.md contract ----------

test("spec 154 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the api-hardening spec`,
    );
  }
});

test("spec 154 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /uploads\/tus\/route\.ts/,
    "plan.md must call out the tus route edit",
  );
  assert.match(
    src,
    /form-drafts\/\[id\]\/route\.ts/,
    "plan.md must call out the form-drafts route edit",
  );
  assert.match(
    src,
    /helpdesk\/tickets\/route\.ts/,
    "plan.md must call out the helpdesk route edit",
  );
});

// ---------- the upload entry point, and the gate that used to sit on it ----------

test("spec 154 — the unauthenticated tusd proxy route is gone entirely", () => {
  // INVERTED. This required /api/uploads/tus to import auth() and declare a
  // requireAuth() helper. The finding behind it was real and serious: five
  // method handlers proxying to an internal service with no session check at
  // all, open to the internet.
  //
  // The route has since been deleted rather than gated, and it is worth being
  // precise about why that is not a regression. The route had never worked. It
  // proxied to a tusd sidecar via TUSD_INTERNAL_URL, which was set in no
  // compose file and no .env, so every branch returned 501; tusd was pointed at
  // a bucket `minio-init` never created; Caddy's route did not match the tus
  // create request; and there were no post-finish hooks, so no rows were ever
  // written and `source='direct'` submissions were unreachable. Spec 154 added
  // an auth gate to a door that opened onto a wall.
  //
  // What it DID have was an unvalidated `?id` interpolated into an internal
  // URL, which is the part that made "open to the internet" more than
  // theoretical. Deleting the route removes both.
  assert.ok(
    !existsSync(resolve(root, TUS_PATH)),
    `${TUS_PATH} must not exist -- see this test for why it was removed rather than gated`,
  );
  // And nothing may quietly stand it back up somewhere else: an internal
  // upload endpoint is exactly the shape that gets reintroduced.
  assert.ok(
    !existsSync(resolve(root, "apps/web/src/app/api/uploads")),
    "no /api/uploads route segment may exist -- bytes go browser -> Storage directly",
  );
});

test("spec 154 — the upload entry point that replaced it authenticates AND authorises", () => {
  // INVERTED from "every method handler calls requireAuth and returns 401".
  //
  // The replacement entry point is a pair of server actions, so there are no
  // method handlers and no status codes to pin -- a failure is a typed
  // `{ ok: false, error }` the caller renders. Two properties carry over, and
  // one is stronger than anything the old route had.
  //
  // Carried over: no session, no upload.
  //
  // Stronger: the old route checked only that SOMEONE was signed in. This one
  // also checks that this particular user may attach a video to this
  // particular context, because contextId arrives from the browser and is
  // attacker-chosen. Without that check a teacher can attach their upload into
  // another teacher's observation cycle -- which is not a read of someone
  // else's data but a WRITE into their evidence. An authentication gate alone
  // would not have caught it.
  const src = read(UPLOAD_ACTIONS_PATH);
  assert.match(
    src,
    /import\s*\{\s*auth\s*\}\s*from\s*"@\/auth"/,
    "uploads/actions.ts must import { auth } from \"@/auth\"",
  );
  /** Body of one exported action: from its declaration to the next export. */
  const bodyOf = (name) => {
    const start = src.indexOf(`export async function ${name}`);
    assert.ok(start > -1, `${name} must exist`);
    const next = src.indexOf("\nexport ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };
  const begin = bodyOf("beginUploadAction");
  assert.match(
    begin,
    /const session = await auth\(\)[\s\S]{0,200}?if\s*\(!actor\s*\|\|\s*!session\)\s*return\s*\{\s*ok:\s*false/,
    "beginUploadAction must refuse before reserving anything when there is no session",
  );
  // The order matters as much as the presence: the refusal has to precede the
  // reservation, or a caller with no session still consumes an object key and
  // leaves a row behind.
  assert.ok(
    begin.indexOf("await auth()") < begin.indexOf("await beginUpload("),
    "the session check must come BEFORE beginUpload reserves anything",
  );
  assert.match(
    begin,
    /assertContextAllowed\(/,
    "beginUploadAction must authorise the CONTEXT, not just the session -- contextId is attacker-chosen",
  );
  const complete = bodyOf("completeUploadAction");
  assert.match(
    complete,
    /const session = await auth\(\)[\s\S]{0,120}?if\s*\(!session\)\s*return\s*\{\s*ok:\s*false/,
    "completeUploadAction must gate on the session too -- it is the call that queues the transcode",
  );
  // And completion must be verified rather than believed: a client claiming it
  // finished, having uploaded nothing, would otherwise push an empty object
  // into the pipeline where it fails in the worker and reads as a transcoding
  // bug rather than an upload that never happened.
  assert.match(
    read(UPLOAD_LIB_PATH),
    /stat\.size\s*<\s*Math\.floor\(row\.expectedBytes\s*\*\s*0\.99\)/,
    "completeUpload must compare the stored object against the reserved size",
  );
});

// ---------- the information the 501 branch used to leak ----------

test("spec 154 — TUSD_INTERNAL_URL is not read anywhere in the web application", () => {
  // INVERTED. The original walked NextResponse.json bodies line by line to
  // prove the env var name and the internal hostname/port never reached a
  // client, while still allowing the file to mention them in a comment and in a
  // console.warn. That was careful work on the right problem -- a 501 body
  // reading `hint: "Set TUSD_INTERNAL_URL=http://tusd:1080 in .env"` hands an
  // anonymous caller the internal service topology.
  //
  // The variable is not read at all now, by anything, so the question of what a
  // response body may contain does not arise. Pinned across the whole tree
  // rather than in one file: what is being guarded is the deployment secret,
  // and a leak is a leak wherever it is interpolated.
  //
  // Comments are stripped first -- several modules explain at length that this
  // variable was set in no compose file and no .env, which is precisely why the
  // route it configured returned 501 on every branch and uploaded nothing.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(resolve(root, rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) files.push(rel);
    }
  };
  walk("apps/web/src");
  for (const file of files) {
    assert.ok(
      !/TUSD_INTERNAL_URL/.test(code(read(file))),
      `${file} must not read TUSD_INTERNAL_URL -- there is no tusd sidecar to point it at`,
    );
  }
});

// ---------- /api/form-drafts/[id] — JSON parse failure ----------

test("spec 154 — form-drafts PUT handler no longer silently swallows malformed JSON", () => {
  const src = read(FORM_DRAFT_PATH);
  // The pre-fix shape was `await req.json().catch(() => ({}))`. The
  // catch swallowed the error and routed an empty object through the
  // Zod schema, which then returned a generic 400. We forbid the literal
  // pattern OUTSIDE comment lines — a code-comment can still reference
  // it as a documentation reference to the pre-fix shape.
  const lines = src.split(/\r?\n/);
  const offending = lines.find((line) => {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return false;
    return /req\.json\(\)\.catch\(\s*\(\)\s*=>\s*\(\{\s*\}\s*\)\s*\)/.test(line);
  });
  assert.equal(
    offending,
    undefined,
    `form-drafts route must not contain \`req.json().catch(() => ({}))\` as live code — spec 154 replaced the silent swallow with an explicit try/catch (offending line: ${offending ?? "<none>"})`,
  );
  // The explicit try/catch must exist — we pin the catch body's response
  // shape (`invalid_json` + `message`) so a refactor can't quietly drop
  // the diagnostic.
  assert.match(
    src,
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,400}error:\s*"invalid_json"/,
    "form-drafts route PUT handler must have a catch branch that returns error: \"invalid_json\"",
  );
  assert.match(
    src,
    /error:\s*"invalid_json"[\s\S]{0,200}message:\s*String\(\s*err\s*\)/,
    "form-drafts route PUT handler must forward the parser error via String(err) for client-side diagnostics",
  );
  // The status code is 400 — preserving the existing contract so no
  // client breakage.
  assert.match(
    src,
    /error:\s*"invalid_json"[\s\S]{0,400}status:\s*400/,
    "form-drafts route PUT handler must return status 400 on JSON parse failure",
  );
});

// ---------- /api/helpdesk/tickets — rate limit ----------

test("spec 154 — helpdesk tickets route imports rateLimit from @/lib/rate-limit", () => {
  const src = read(HELPDESK_PATH);
  assert.match(
    src,
    /import\s*\{\s*rateLimit\s*\}\s*from\s*"@\/lib\/rate-limit"/,
    "helpdesk/tickets/route.ts must import { rateLimit } from \"@/lib/rate-limit\"",
  );
});

test("spec 154 — helpdesk tickets route calls rateLimit with the correct bucket / id / limit / window", () => {
  const src = read(HELPDESK_PATH);
  // The call shape — bucket="helpdesk", id=userId (the session.user.id
  // resolved at the top of the handler), limit=5, windowMs=60*60*1000.
  // The regex tolerates whitespace + the limit/window being expressed
  // as inline literals or named constants (we declared HELPDESK_LIMIT
  // and HELPDESK_WINDOW_MS in the implementation).
  assert.match(
    src,
    /rateLimit\(\s*\{[\s\S]{0,400}bucket:\s*"helpdesk"/,
    "helpdesk route must call rateLimit with bucket \"helpdesk\"",
  );
  assert.match(
    src,
    /rateLimit\(\s*\{[\s\S]{0,400}id:\s*userId/,
    "helpdesk route must call rateLimit with id: userId so the throttle is per-user",
  );
  // The limit/window must be either inline literals or the named
  // constants. Both shapes are acceptable — pin the values somewhere
  // in the file so a future tweak shows up.
  assert.ok(
    /HELPDESK_LIMIT\s*=\s*5/.test(src) || /limit:\s*5\b/.test(src),
    "helpdesk route must throttle at 5 tickets (either as HELPDESK_LIMIT = 5 or limit: 5 inline)",
  );
  assert.ok(
    /HELPDESK_WINDOW_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/.test(src) ||
      /windowMs:\s*60\s*\*\s*60\s*\*\s*1000/.test(src),
    "helpdesk route must throttle over a 60-minute window (60 * 60 * 1000 ms)",
  );
});

test("spec 154 — helpdesk tickets route returns 429 with Retry-After on limit hit and audits", () => {
  const src = read(HELPDESK_PATH);
  // 429 status — pinning the response status so a future refactor can't
  // silently swap it for (say) 503.
  assert.match(
    src,
    /status:\s*429/,
    "helpdesk route must return status 429 on rate-limit hit",
  );
  // Retry-After header — clients (and curl users) read this to know
  // when to retry. Pinning it ensures the header survives a refactor.
  assert.match(
    src,
    /"Retry-After":/,
    "helpdesk route must set a Retry-After header on the 429 response",
  );
  // The rate_limited token in the response body so the client can
  // distinguish a throttle from an auth failure.
  assert.match(
    src,
    /"rate_limited"/,
    "helpdesk route 429 body must include the rate_limited error token",
  );
  // The audit row — spec 154 mandates a `helpdesk.ticket_rate_limited`
  // action so abuse patterns are visible in the audit log even when
  // Redis is down (the audit is the deterrent for the fail-open path).
  assert.match(
    src,
    /helpdesk\.ticket_rate_limited/,
    "helpdesk route must record an audit row with action \"helpdesk.ticket_rate_limited\" on throttle hit",
  );
});

test("spec 154 — helpdesk tickets route fails OPEN on Redis fault (logs and falls through)", () => {
  const src = read(HELPDESK_PATH);
  // The fail-open posture is a deliberate design choice (research.md §4).
  // We pin its shape so a future contributor can't quietly switch it to
  // fail-closed without consulting the spec. The shape: try { rateLimit
  // }... catch (err) { console.warn(...) }.
  assert.match(
    src,
    /try\s*\{[\s\S]{0,800}rateLimit\(/,
    "helpdesk route must wrap the rateLimit call in a try block",
  );
  assert.match(
    src,
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,300}console\.warn\(/,
    "helpdesk route must log via console.warn in the catch branch (fail-open posture)",
  );
  // The catch branch must NOT return — the handler falls through to the
  // ticket-creation path so a Redis outage doesn't block real users.
  // We approximate "no return" by checking the catch body doesn't
  // contain a NextResponse.json call.
  const catchBlockMatch = src.match(/catch\s*\([^)]*\)\s*\{([\s\S]{0,500})\}/);
  if (catchBlockMatch) {
    assert.ok(
      !/NextResponse\.json/.test(catchBlockMatch[1]),
      "helpdesk route rate-limit catch branch must NOT return a NextResponse — the fail-open posture requires falling through to the ticket-creation path",
    );
  }
});

// ---------- No-regression / hygiene ----------

test("spec 154 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  // TUS_PATH swapped for the modules that replaced it: reading a deleted file
  // throws ENOENT and reports nothing about hygiene.
  for (const path of [UPLOAD_ACTIONS_PATH, UPLOAD_LIB_PATH, FORM_DRAFT_PATH, HELPDESK_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 154 — no new dependencies were introduced", () => {
  // Every fix uses existing helpers (auth, rateLimit, recordAudit). The
  // package.json should be byte-identical to its pre-spec state, so we
  // pin the absence of plausible-but-unwanted additions.
  const pkg = read("apps/web/package.json");
  assert.ok(
    !/express-rate-limit/.test(pkg),
    "apps/web must not depend on express-rate-limit — the fix uses the existing @/lib/rate-limit helper",
  );
  assert.ok(
    !/p-throttle/.test(pkg),
    "apps/web must not depend on p-throttle — the fix uses the existing Redis-backed rateLimit",
  );
});

test("spec 154 — the fix is documented inline so future contributors don't quietly revert it", () => {
  // The inline comments in each touched file reference Spec 154 by
  // number so a future refactor reading the file knows to consult the
  // spec before reverting the gate / the rate limit / the error shape.
  //
  // Two of the three files still carry it. The third -- the tus route -- was
  // deleted, and its spec-154 marker cannot survive a file that does not
  // exist. It is replaced below by prose assertions against the modules that
  // took over the upload lifecycle, because the thing worth making
  // unrevertable there was never "consult spec 154": it was the reason the
  // route could not simply be gated and kept.
  for (const path of [FORM_DRAFT_PATH, HELPDESK_PATH]) {
    const src = read(path);
    assert.match(
      src,
      /Spec 154/,
      `${path} must carry an inline \`Spec 154\` reference so the fix is self-documenting`,
    );
  }
  // The upload path documents itself instead: what it replaced, and why the
  // replacement is not just a relocation. Both facts are the ones a future
  // contributor would need before proposing "let's put the tus proxy back so
  // uploads go through our own domain".
  const libSrc = read(UPLOAD_LIB_PATH);
  assert.match(
    libSrc,
    /tusd/i,
    "upload.ts must name the tusd path it replaced, so the history is discoverable from the code",
  );
  assert.match(
    libSrc,
    /Supabase requires a chunk size of EXACTLY 6 MiB/,
    "upload.ts must record why the chunk size is server-issued and not a caller's choice -- " +
      "the two hand-maintained copies it replaced were both set to an invalid 5 MB",
  );
  assert.match(
    read(UPLOAD_ACTIONS_PATH),
    /contextId arrives from the browser and is attacker-chosen/,
    "uploads/actions.ts must state why context authorisation exists -- an authentication " +
      "check alone would let a teacher write into another teacher's evidence",
  );
});
