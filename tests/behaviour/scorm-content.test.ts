// SCORM package files are served SAME-ORIGIN, under their own CSP -- the
// real route handler, against Postgres and an in-process Storage.
//
// ── WHY THE ROUTE IS SHAPED THIS WAY ─────────────────────────────────────────
//
// A SCO finds the LMS by walking window.parent looking for `API`. That is a
// same-origin DOM access, so the package must be served from the
// application's own origin -- not from a signed Supabase URL. And SCORM
// content is built on inline <script> and, often, eval(): the application's
// strict nonce CSP (lib/csp.ts buildCsp, applied by proxy.ts) would block
// every line of it. So:
//   - ONLY this route carries a policy that permits inline script
//     (buildScormContentCsp), and proxy.ts's matcher excludes the route, so
//     the nonce policy is not ALSO sent -- two CSP headers are both enforced,
//     and their intersection would block the content again;
//   - everything else keeps the strict policy (tests/behaviour/csp.test.ts);
//   - the policy's `sandbox` flags are the ones the player's <iframe> carries;
//   - a service worker cannot be installed from package content (it would
//     outlive the package and intercept this path on every later launch);
//   - a file is served only if the upload registered it, only to a viewer
//     who may launch the package, with the type from the allowlist, nosniff,
//     and a forwarded Range so video can seek.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/node-postgres";
import { stubSupabaseServer, request } from "./_ui.js";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";
import { startFakeStorage, type FakeStorage } from "./_storage.js";

stubSupabaseServer();
const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createClient } = webRequire("@supabase/supabase-js") as typeof import("@supabase/supabase-js");

const directive = (csp: string, name: string) =>
  csp.split(";").map((d) => d.trim()).find((d) => d === name || d.startsWith(`${name} `)) ?? "";

test("the content policy permits inline and eval'd script from the package's own origin, and nothing else does", async () => {
  const { buildCsp, buildScormContentCsp } = await import("../../apps/web/src/lib/csp.ts");
  const { SCORM_SANDBOX } = await import("../../apps/web/src/lib/scorm/sandbox.ts");
  const csp = buildScormContentCsp();
  assert.equal(directive(csp, "script-src"), "script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  assert.doesNotMatch(csp, /nonce-|strict-dynamic/, "a nonce would make browsers ignore 'unsafe-inline'");
  assert.equal(directive(csp, "default-src"), "default-src 'self'", "no third-party host: a package cannot phone home");
  assert.equal(directive(csp, "connect-src"), "connect-src 'self'");
  assert.equal(directive(csp, "frame-ancestors"), "frame-ancestors 'self'", "only our own player may frame it");
  assert.equal(directive(csp, "object-src"), "object-src 'none'");
  assert.equal(directive(csp, "sandbox"), `sandbox ${SCORM_SANDBOX}`, "the same flags as the player's iframe");
  assert.match(SCORM_SANDBOX, /\ballow-scripts\b/);
  assert.match(SCORM_SANDBOX, /\ballow-same-origin\b/, "without it the SCO cannot reach window.parent.API");
  assert.doesNotMatch(SCORM_SANDBOX, /allow-top-navigation/, "content must not navigate the app away");
  // The application's own policy is untouched.
  const app = buildCsp("n");
  assert.doesNotMatch(directive(app, "script-src"), /unsafe-inline|unsafe-eval/);
});

test("the proxy does not run on package content, so the nonce policy is not sent beside the content policy", async () => {
  const { config } = await import("../../apps/web/src/proxy.ts");
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  const id = randomUUID();
  for (const path of [`/api/scorm/content/${id}/index.html`, `/api/scorm/content/${id}/story_html5.html`, `/api/scorm/content/${id}/a/b`]) {
    assert.equal(matcher.test(path), false, `${path} must not pass through proxy.ts`);
  }
  for (const path of ["/rtt", `/scorm/${id}`, `/api/scorm/attempts/${id}`, "/admin/scorm"]) {
    assert.equal(matcher.test(path), true, `${path} still gets the session refresh and the strict policy`);
  }
});

type World = { w: RttWorld; storage: FakeStorage; pkgId: string; farId: string; files: Record<string, Buffer> };

async function withContent(body: (x: World) => Promise<void>) {
  const w = await rttWorld("sccn");
  const storage = await startFakeStorage();
  try {
    const { insertPackage } = await import("../../apps/web/src/lib/scorm/store.ts");
    const db = drizzle(w.c);
    const files: Record<string, Buffer> = {
      "index.html": Buffer.from("<!doctype html><script>window.parent.API.LMSInitialize('')</script>"),
      "my lesson.html": Buffer.from("<p>spaced</p>"),
      "media/clip.mp4": Buffer.from("0123456789"),
    };
    const make = async (subjectId: string) => {
      const id = randomUUID();
      const entries = Object.entries(files).map(([path, data], n) => ({ path, objectKey: `${id}/${n}`, sizeBytes: data.length, data }));
      for (const e of entries) storage.put("scorm-packages", e.objectKey, e.data);
      await insertPackage(db, {
        id,
        rttSubjectId: subjectId,
        title: `Pkg ${w.T}`,
        manifestIdentifier: "x",
        launchPath: "index.html",
        launchQuery: "",
        masteryScore: null,
        launchData: null,
        uploadedByUserId: w.admin.id,
        totalBytes: 1,
        files: entries.map(({ path, objectKey, sizeBytes }) => ({ path, objectKey, sizeBytes })),
      });
      return id;
    };
    const pkgId = await make(await w.subject({ zoneId: w.zoneId }));
    const farId = await make(await w.subject({ zoneId: w.zoneYId }));
    request.supabaseAdmin = createClient(storage.url, "service-role-test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await body({ w, storage, pkgId, farId, files });
  } finally {
    signIn(null);
    await storage.close();
    await w.cleanup();
  }
}

async function get(id: string, path: string[], headers: Record<string, string> = {}) {
  const { GET } = await import("../../apps/web/src/app/api/scorm/content/[id]/[...path]/route.ts");
  const url = `http://app.test/api/scorm/content/${id}/${path.map(encodeURIComponent).join("/")}`;
  return GET(new Request(url, { headers }), { params: Promise.resolve({ id, path }) });
}

test("a learner who may launch the package gets its file, typed from the allowlist, under the content policy", { skip }, async () => {
  await withContent(async ({ w, pkgId, files }) => {
    signIn(w.teacher);
    const res = await get(pkgId, ["index.html"]);
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), files["index.html"]!.toString());
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", "from the allowlist, not from Storage");
    assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("cache-control") ?? "", /^private/, "never a shared cache");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.ok(res.headers.get("permissions-policy"), "the baseline headers proxy.ts would have set are set here");

    const spaced = await get(pkgId, ["my lesson.html"]);
    assert.equal(spaced.status, 200, "a decoded name with a space is found");
  });
});

test("video can seek: a single Range is forwarded and answered 206", { skip }, async () => {
  await withContent(async ({ w, pkgId }) => {
    signIn(w.teacher);
    const res = await get(pkgId, ["media", "clip.mp4"], { range: "bytes=2-5" });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "2345");
    const whole = await get(pkgId, ["media", "clip.mp4"], { range: "bytes=0-1,4-5" });
    assert.equal(whole.status, 200, "a multi-range request is answered whole rather than forwarded");
  });
});

test("nothing else is served: signed out, unregistered paths, other places, withdrawn packages, service workers", { skip }, async () => {
  await withContent(async ({ w, storage, pkgId, farId }) => {
    signIn(null);
    assert.equal((await get(pkgId, ["index.html"])).status, 401);

    signIn(w.teacher);
    assert.equal((await get(pkgId, ["missing.html"])).status, 404);
    assert.equal((await get(pkgId, ["..", "index.html"])).status, 404);
    assert.equal((await get(pkgId, ["index.php"])).status, 404, "a type outside the allowlist is never looked up");
    assert.equal((await get(farId, ["index.html"])).status, 404, "a subject not taught in her place: not revealed as forbidden");
    assert.equal((await get("not-a-uuid", ["index.html"])).status, 404);

    const sw = await get(pkgId, ["index.html"], { "service-worker": "script" });
    assert.equal(sw.status, 403, "a service worker script is refused");

    await w.c.query(`UPDATE scorm_packages SET active = false WHERE id = $1`, [pkgId]);
    assert.equal((await get(pkgId, ["index.html"])).status, 404, "withdrawn");
    signIn(w.admin);
    assert.equal((await get(pkgId, ["index.html"])).status, 200, "an administrator can still open it");

    storage.put("scorm-packages", "unused", Buffer.alloc(0));
    await w.c.query(`UPDATE scorm_package_files SET object_key = 'gone/0' WHERE package_id = $1 AND path = 'index.html'`, [pkgId]);
    assert.equal((await get(pkgId, ["index.html"])).status, 502, "a registered file Storage cannot produce is an upstream failure");
  });
});
