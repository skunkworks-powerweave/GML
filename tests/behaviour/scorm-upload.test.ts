// POST /api/scorm/packages -- a super_admin uploads a SCORM 1.2 .zip for an
// RTT subject. The real route handler, against Postgres and an in-process
// Storage, with archives written by ./_zip.ts.
//
// ── WHAT MUST HOLD ───────────────────────────────────────────────────────────
//
//   - SUPER_ADMIN ONLY. A package's script runs on this origin as whoever
//     opens it (it must: a SCO reaches window.parent.API), and the session
//     cookie is readable by script. A programme_admin who could upload could
//     act as any super_admin who later opened the module -- and a
//     programme_admin cannot otherwise become one (admin/users).
//   - Nothing is stored unless the whole package validates
//     (lib/scorm/package.ts); a refusal names the reason and the files.
//   - Stored files are opaque bytes under `<id>/<n>`, the registry lists
//     exactly the validated files, and the upload is audited.
//   - A Storage failure part-way leaves nothing behind: no row, no objects.
//   - The body is bounded before it is read, cross-origin posts are refused,
//     and proxy.ts does not buffer the route (it truncates bodies over 10 MB).
//   - End to end: what was uploaded is what the content route serves.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { stubSupabaseServer, request } from "./_ui.js";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld, type RttWorld } from "./_rtt-world.js";
import { startFakeStorage, type FakeStorage } from "./_storage.js";
import { buildZip, manifest12 } from "./_zip.js";

stubSupabaseServer();
const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createClient } = webRequire("@supabase/supabase-js") as typeof import("@supabase/supabase-js");

const INDEX = "<!doctype html><script>window.parent.API.LMSInitialize('')</script>";
const goodZip = () =>
  buildZip([
    { name: "imsmanifest.xml", data: manifest12({ title: "Story time" }) },
    { name: "index.html", data: INDEX },
    { name: "img/cat.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: "__MACOSX/._index.html", data: "junk" },
  ]);

type Ctx = { w: RttWorld; storage: FakeStorage; subjectId: string; superAdmin: { id: string; role: string; name: string } };

async function withUpload(body: (x: Ctx) => Promise<void>) {
  const w = await rttWorld("scup");
  const storage = await startFakeStorage();
  try {
    const superAdmin = await w.user("Root", "super_admin");
    request.supabaseAdmin = createClient(storage.url, "service-role-test-key", { auth: { persistSession: false, autoRefreshToken: false } });
    await body({ w, storage, subjectId: await w.subject({ zoneId: w.zoneId }), superAdmin });
  } finally {
    signIn(null);
    await storage.close();
    await w.cleanup();
  }
}

function upload(fields: { file?: Buffer; rttSubjectId?: string; title?: string }, headers: Record<string, string> = {}) {
  const fd = new FormData();
  if (fields.file) fd.set("file", new Blob([fields.file], { type: "application/zip" }), "course.zip");
  if (fields.rttSubjectId !== undefined) fd.set("rttSubjectId", fields.rttSubjectId);
  if (fields.title !== undefined) fd.set("title", fields.title);
  return import("../../apps/web/src/app/api/scorm/packages/route.ts").then(({ POST }) =>
    POST(new Request("http://app.test/api/scorm/packages", { method: "POST", body: fd, headers: { host: "app.test", ...headers } })),
  );
}

const packagesOf = async (w: RttWorld, subjectId: string) =>
  (await w.c.query(`SELECT * FROM scorm_packages WHERE rtt_subject_id = $1`, [subjectId])).rows;

test("a super_admin's upload is validated, stored as opaque bytes, registered, audited, and served", { skip }, async () => {
  await withUpload(async ({ w, storage, subjectId, superAdmin }) => {
    signIn(superAdmin);
    const res = await upload({ file: goodZip(), rttSubjectId: subjectId });
    assert.equal(res.status, 201, await res.clone().text());
    const { id, title, fileCount } = (await res.json()) as { id: string; title: string; fileCount: number };
    assert.equal(title, "Story time", "the manifest's title");
    assert.equal(fileCount, 3, "the macOS litter is not stored");

    const [pkg] = await packagesOf(w, subjectId);
    assert.equal(pkg.id, id);
    assert.equal(pkg.launch_path, "index.html");
    assert.equal(pkg.uploaded_by_user_id, superAdmin.id);
    const files = (await w.c.query(`SELECT path, object_key, size_bytes FROM scorm_package_files WHERE package_id = $1 ORDER BY path`, [id])).rows;
    assert.deepEqual(files.map((f) => f.path as string).sort(), ["img/cat.png", "imsmanifest.xml", "index.html"]);
    for (const f of files) {
      assert.match(f.object_key, new RegExp(`^${id}/\\d+$`), "keys are ours, never the archive's names");
      const obj = storage.get("scorm-packages", f.object_key);
      assert.ok(obj, `${f.path} is stored`);
      assert.equal(obj!.contentType, "application/octet-stream", "stored as opaque bytes");
      assert.equal(obj!.body.length, f.size_bytes);
    }
    const stored = storage.get("scorm-packages", files.find((f) => f.path === "index.html")!.object_key)!;
    assert.equal(stored.body.toString(), INDEX);
    assert.deepEqual(storage.keys("scorm-packages").filter((k) => k.startsWith(id)).length, 3);

    const { rows: audit } = await w.c.query(`SELECT action, entity_type, user_id, metadata FROM audit_log WHERE entity_id = $1 AND action = 'scorm.package.upload'`, [id]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].user_id, superAdmin.id);
    const doc = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
    const line = doc.slice(doc.indexOf("## scorm.*")).split("\n").find((l) => l.startsWith("| `scorm.package.upload` |"));
    assert.ok(line, "scorm.package.upload is documented");
    for (const key of [...Object.keys(audit[0].metadata), audit[0].entity_type]) assert.ok(line!.includes(`\`${key}\``), `${key} documented`);

    // End to end: a teacher in the subject's place gets the uploaded bytes.
    signIn(w.teacher);
    const { GET } = await import("../../apps/web/src/app/api/scorm/content/[id]/[...path]/route.ts");
    const served = await GET(new Request(`http://app.test/api/scorm/content/${id}/index.html`), { params: Promise.resolve({ id, path: ["index.html"] }) });
    assert.equal(served.status, 200);
    assert.equal(await served.text(), INDEX);
  });
});

test("only a super_admin may upload", { skip }, async () => {
  await withUpload(async ({ w, storage, subjectId }) => {
    signIn(null);
    assert.equal((await upload({ file: goodZip(), rttSubjectId: subjectId })).status, 401);
    for (const who of [w.admin, w.teacher, w.mentor]) {
      signIn(who);
      assert.equal((await upload({ file: goodZip(), rttSubjectId: subjectId })).status, 403, who.role);
    }
    assert.equal((await packagesOf(w, subjectId)).length, 0);
    assert.deepEqual(storage.keys("scorm-packages"), []);
  });
});

test("a refused package stores nothing and says why, naming the files", { skip }, async () => {
  await withUpload(async ({ w, storage, subjectId, superAdmin }) => {
    signIn(superAdmin);
    const evil = buildZip([
      { name: "imsmanifest.xml", data: manifest12() },
      { name: "index.html", data: INDEX },
      { name: "../../etc/cron.d/x.html", data: "pwn" },
    ]);
    const res = await upload({ file: evil, rttSubjectId: subjectId });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string; message: string; paths: string[] } };
    assert.equal(body.error.code, "unsafe_path");
    assert.deepEqual(body.error.paths, ["../../etc/cron.d/x.html"]);
    assert.match(body.error.message, /outside the package/);

    const php = buildZip([{ name: "imsmanifest.xml", data: manifest12() }, { name: "index.html", data: INDEX }, { name: "x.php", data: "<?php" }]);
    assert.equal(((await (await upload({ file: php, rttSubjectId: subjectId })).json()) as { error: { code: string } }).error.code, "disallowed_type");
    assert.equal((await upload({ file: Buffer.from("not a zip"), rttSubjectId: subjectId })).status, 422);

    assert.equal((await packagesOf(w, subjectId)).length, 0);
    assert.deepEqual(storage.keys("scorm-packages"), []);
  });
});

test("the request itself is bounded and checked before any archive is read", { skip }, async () => {
  await withUpload(async ({ w, storage, subjectId, superAdmin }) => {
    const { SCORM_LIMITS } = await import("../../apps/web/src/lib/scorm/package.ts");
    signIn(superAdmin);
    const declared = await upload({ file: goodZip(), rttSubjectId: subjectId }, { "content-length": String(SCORM_LIMITS.maxPackageBytes * 2) });
    assert.equal(declared.status, 413, "refused from the declared length");
    const actual = await upload({ file: Buffer.alloc(SCORM_LIMITS.maxPackageBytes + 1), rttSubjectId: subjectId });
    assert.equal(actual.status, 413, "and from the bytes, when no length is declared");
    assert.equal((await upload({ rttSubjectId: subjectId })).status, 400, "no file");
    assert.equal((await upload({ file: goodZip(), rttSubjectId: "nope" })).status, 400, "no subject");
    const unknown = await upload({ file: goodZip(), rttSubjectId: randomUUID() });
    assert.equal(unknown.status, 422);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "unknown_subject");
    const crossSite = await upload({ file: goodZip(), rttSubjectId: subjectId }, { origin: "https://evil.example" });
    assert.equal(crossSite.status, 403, "a cross-origin post is refused");
    assert.equal((await upload({ file: goodZip(), rttSubjectId: subjectId }, { origin: "http://app.test" })).status, 201, "a same-origin one is not");
    assert.equal((await packagesOf(w, subjectId)).length, 1);
    assert.equal(storage.keys("scorm-packages").length, 3);
  });
});

test("a Storage failure part-way leaves no row and no objects", { skip }, async () => {
  await withUpload(async ({ w, storage, subjectId, superAdmin }) => {
    const real = request.supabaseAdmin as ReturnType<typeof createClient>;
    let uploads = 0;
    request.supabaseAdmin = {
      storage: {
        from: (bucket: string) => {
          const r = real.storage.from(bucket);
          return {
            upload: (key: string, data: unknown, opts: unknown) =>
              ++uploads === 3 ? Promise.resolve({ data: null, error: { message: "storage is down" } }) : r.upload(key, data as Blob, opts as never),
            remove: (keys: string[]) => r.remove(keys),
            createSignedUrl: (key: string, ttl: number) => r.createSignedUrl(key, ttl),
          };
        },
      },
    };
    signIn(superAdmin);
    const res = await upload({ file: goodZip(), rttSubjectId: subjectId });
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "storage_failed");
    assert.equal((await packagesOf(w, subjectId)).length, 0);
    assert.deepEqual(storage.keys("scorm-packages"), [], "every object already written is removed again");
  });
});

test("proxy.ts does not buffer the upload route (it would truncate a body over 10 MB)", async () => {
  const { config } = await import("../../apps/web/src/proxy.ts");
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  assert.equal(matcher.test("/api/scorm/packages"), false);
  assert.equal(matcher.test("/admin/scorm"), true);
});
