// The direct-to-Storage video upload, executed.
//
// These run the REAL apps/web/src/lib/video/tus-upload.ts, with the real
// tus-js-client, against a local HTTP server standing in for Supabase Storage's
// resumable endpoint. The server speaks enough tus (create, HEAD, PATCH) to
// resume, records what the upload sends, and answers the way Storage answered
// when the same requests were made against a local Supabase stack
// (2026-09-24, storage-api via `supabase start`):
//
//   same teacher token, same own-prefix key, `x-upsert: true`
//       -> 403  "new row violates row-level security policy"
//   same request without `x-upsert`
//       -> 201, Upload-Offset = the whole file
//   a token Storage cannot verify (bad signature, or none)
//       -> 400  {"statusCode":"403","error":"Unauthorized","message":"signature verification failed"}
//
// Why the upsert is refused: _post/005 gives `authenticated` INSERT, UPDATE and
// DELETE on storage.objects under the caller's own uuid prefix, and no SELECT.
// An upsert has to look for an existing row first, and without SELECT Storage
// reports that as an RLS violation. So every teacher's upload was refused, and
// the tray said "Your session expired" -- advice that cannot help, because
// signing in again yields a token Storage refuses in exactly the same way.
//
// The resume store is the one thing faked on the client: tus-js-client's Node
// build keeps none, so the tests install one that behaves like the browser's
// localStorage store -- including matching every earlier upload of the same
// file, which is how the browser's store behaves too.
//
// No database, no Supabase: runs everywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import "./_ui.js"; // installs the @/ alias and the @/lib/supabase/browser stub
import { TEST_ACCESS_TOKEN, testTokens } from "./_stubs/supabase-browser.ts";

// Imported inside the helper: test files compile to CommonJS, which has no top-level await.
const tusUpload = () => import("../../apps/web/src/lib/video/tus-upload.ts");

// The same tus-js-client instance tus-upload.ts loads, resolved from apps/web.
const tus = createRequire(new URL("../../apps/web/package.json", import.meta.url))("tus-js-client") as {
  defaultOptions: { urlStorage: unknown };
};

const RESUMABLE = "/storage/v1/upload/resumable";
const KEY = "6cac8bdb-2da5-4acf-9800-47aa131d60ed/affb0b8a-6fe1-4add-9e44-2b42655faaaa.mp4";
const OTHER_KEY = "6cac8bdb-2da5-4acf-9800-47aa131d60ed/0f30f424-1654-4fd7-81ae-cb9925662052.mp4";
const BYTES = Buffer.from("fake mp4 bytes, ".repeat(64));

type Reply = { status: number; body: string };
type Seen = { method: string; url: string; headers: IncomingHttpHeaders; bytes: number };

/** The objectName a tus creation request asked for. */
function objectNameOf(s: Seen): string | null {
  const meta = String(s.headers["upload-metadata"] ?? "");
  const pair = meta.split(",").map((p) => p.trim().split(" ")).find(([k]) => k === "objectName");
  return pair?.[1] ? Buffer.from(pair[1], "base64").toString() : null;
}

/**
 * A stand-in for Storage's resumable endpoint. `refuse` may answer a creation
 * request itself, and `gate` any request at all (Storage checks the bearer
 * token's signature and exp on EVERY request, not only the first); otherwise
 * uploads are created, HEAD reports their offset, and PATCH appends.
 */
async function fakeStorage(
  refuse: (req: Seen) => Reply | null = () => null,
  gate: (req: Seen) => Reply | null = () => null,
) {
  const seen: Seen[] = [];
  const uploads = new Map<string, { offset: number; length: number }>();
  let next = 0;
  const server = createServer((req, res) => {
    let bytes = 0;
    req.on("data", (chunk: Buffer) => (bytes += chunk.length));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, bytes };
      seen.push(s);
      const tusHeaders = { "tus-resumable": "1.0.0", "cache-control": "no-store" };
      const denied = gate(s);
      if (denied) {
        res.writeHead(denied.status, { ...tusHeaders, "content-type": "application/json" });
        res.end(denied.body);
        return;
      }
      if (s.method === "POST" && s.url === RESUMABLE) {
        const r = refuse(s);
        if (r) {
          res.writeHead(r.status, { "content-type": "text/plain" });
          res.end(r.body);
          return;
        }
        const path = `${RESUMABLE}/upload-${++next}`;
        uploads.set(path, { offset: bytes, length: Number(s.headers["upload-length"]) });
        res.writeHead(201, { ...tusHeaders, location: path, "upload-offset": String(bytes) });
        res.end();
        return;
      }
      const u = uploads.get(s.url);
      if (!u) {
        res.writeHead(404, tusHeaders);
        res.end();
        return;
      }
      if (s.method === "HEAD") {
        res.writeHead(200, { ...tusHeaders, "upload-offset": String(u.offset), "upload-length": String(u.length) });
        res.end();
        return;
      }
      if (s.method === "PATCH") {
        u.offset += bytes;
        res.writeHead(204, { ...tusHeaders, "upload-offset": String(u.offset) });
        res.end();
        return;
      }
      res.writeHead(405, tusHeaders);
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    seen,
    /** An upload that already exists on the server, as a previous attempt left it. */
    existing: (offset: number) => {
      const path = `${RESUMABLE}/upload-${++next}`;
      uploads.set(path, { offset, length: BYTES.length });
      return `${url}${path}`;
    },
    close: () => new Promise((ok) => server.close(ok)),
  };
}

type Entry = { size: number; metadata: Record<string, string>; creationTime: string; uploadUrl: string; urlStorageKey: string };

/** tus's resume store, as the browser's localStorage store behaves. */
function resumeStore(entries: Array<Omit<Entry, "urlStorageKey" | "creationTime" | "size">>) {
  let n = 0;
  const all = new Map<string, Entry>();
  for (const e of entries) {
    const key = `tus::fp::${++n}`;
    all.set(key, { size: BYTES.length, creationTime: new Date().toString(), urlStorageKey: key, ...e });
  }
  return {
    all,
    store: {
      // The browser's store matches on the file's fingerprint -- name, type,
      // size, modified time -- so every earlier upload of the same file matches.
      findUploadsByFingerprint: async () => [...all.values()],
      findAllUploads: async () => [...all.values()],
      removeUpload: async (key: string) => void all.delete(key),
      addUpload: async (_fp: string, upload: Omit<Entry, "urlStorageKey">) => {
        const key = `tus::fp::${++n}`;
        all.set(key, { ...upload, urlStorageKey: key } as Entry);
        return key;
      },
    },
  };
}

/** Run one upload to completion and report how it ended. */
function upload(
  storageUrl: string,
  store: unknown = resumeStore([]).store,
  chunkBytes = 6 * 1024 * 1024,
): Promise<{ ok: true } | { ok: false; message: string }> {
  tus.defaultOptions.urlStorage = store;
  // tus-js-client's Node build reads a Buffer; `type` is what the File would carry.
  const file = Object.assign(Buffer.from(BYTES), { type: "video/mp4" });
  return new Promise((resolve) => {
    void tusUpload().then(({ startResumableUpload }) =>
      startResumableUpload({
        file: file as unknown as File,
        bucket: "videos-original",
        objectKey: KEY,
        chunkBytes,
        supabase: { url: storageUrl, anonKey: "publishable-key" },
        onProgress: () => undefined,
        onError: (message) => resolve({ ok: false, message }),
        onSuccess: () => resolve({ ok: true }),
      }),
    );
  });
}

/** Storage's own refusal of an upsert the caller may not make. */
const policyRefusal = (s: Seen): Reply | null =>
  s.headers["x-upsert"] === "true" ? { status: 403, body: "new row violates row-level security policy" } : null;

test("a teacher's upload creates the object without asking Storage to overwrite", async () => {
  const storage = await fakeStorage(policyRefusal);
  try {
    const result = await upload(storage.url);
    const create = storage.seen.find((s) => s.method === "POST");
    assert.ok(create, "the upload must open with a tus creation request");
    assert.notEqual(
      create.headers["x-upsert"],
      "true",
      "x-upsert asks Storage to overwrite an existing object. The key is new for every " +
        "reservation, so there is nothing to overwrite, and the policies deliberately grant " +
        "no SELECT -- which an upsert needs -- so Storage refuses it for every teacher",
    );
    assert.equal(create.headers.authorization, `Bearer ${TEST_ACCESS_TOKEN}`, "the user's own token, so RLS applies");
    assert.equal(objectNameOf(create), KEY, "the bytes go to the server-issued key");
    assert.deepEqual(result, { ok: true }, "the whole file went up in the creation request; the upload must succeed");
  } finally {
    await storage.close();
  }
});

test("an earlier upload of the same file, to a different reservation, is not resumed", async () => {
  const storage = await fakeStorage();
  try {
    // What the browser still holds after uploading this file once before: a
    // FINISHED upload, bound to that earlier reservation's key.
    const finished = storage.existing(BYTES.length);
    const { store } = resumeStore([{ metadata: { objectName: OTHER_KEY }, uploadUrl: finished }]);
    const result = await upload(storage.url, store);
    assert.deepEqual(result, { ok: true });
    const create = storage.seen.find((s) => s.method === "POST");
    assert.ok(
      create,
      "resuming the earlier upload 'succeeds' at once without sending a byte to this reservation's key, " +
        "and the completion check then reports the file missing -- for every retry, forever",
    );
    assert.equal(objectNameOf(create), KEY);
    assert.ok(!storage.seen.some((s) => storage.url + s.url === finished), "the other reservation's upload must not be touched");
  } finally {
    await storage.close();
  }
});

test("an interrupted upload to this reservation is resumed, not restarted", async () => {
  const storage = await fakeStorage();
  try {
    const half = Math.floor(BYTES.length / 2);
    const partial = storage.existing(half);
    const { store } = resumeStore([{ metadata: { objectName: KEY }, uploadUrl: partial }]);
    const result = await upload(storage.url, store);
    assert.deepEqual(result, { ok: true });
    assert.ok(!storage.seen.some((s) => s.method === "POST"), "a resume must not start the transfer again from byte zero");
    const patch = storage.seen.find((s) => s.method === "PATCH");
    assert.ok(patch, "the rest of the file must be sent to the existing upload");
    assert.equal(patch.bytes, BYTES.length - half, "only the bytes the server does not already have");
  } finally {
    await storage.close();
  }
});

test("a finished upload leaves nothing behind for a later upload of the same file to resume", async () => {
  const storage = await fakeStorage();
  try {
    const { store, all } = resumeStore([]);
    const result = await upload(storage.url, store);
    assert.deepEqual(result, { ok: true });
    assert.equal(all.size, 0, "the entry for a finished upload is what the next upload of this file would wrongly resume");
  } finally {
    await storage.close();
  }
});

test("a refusal by Storage's access policy is not reported as an expired session", async () => {
  const storage = await fakeStorage(() => ({ status: 403, body: "new row violates row-level security policy" }));
  try {
    const result = await upload(storage.url);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.doesNotMatch(
      result.message,
      /session|sign in/i,
      "the token was fine; telling the teacher to sign in again sends them round a loop that cannot succeed",
    );
    assert.match(result.message, /WhatsApp/, "the fallback that still works must be named");
    assert.match(result.message, /admin/i, "a refused upload is a deployment fault; the teacher has to be told who can fix it");
  } finally {
    await storage.close();
  }
});

test("a token Storage cannot verify is reported as an expired session", async () => {
  const storage = await fakeStorage(() => ({
    status: 400,
    body: '{"statusCode":"403","code":"AccessDenied","error":"Unauthorized","message":"signature verification failed"}',
  }));
  try {
    const result = await upload(storage.url);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /session expired/i, "here signing in again IS the fix");
  } finally {
    await storage.close();
  }
});

test("an expired token is reported as an expired session", async () => {
  const storage = await fakeStorage(() => ({
    status: 400,
    body: '{"statusCode":"403","code":"InvalidJWT","error":"Unauthorized","message":"jwt expired"}',
  }));
  try {
    const result = await upload(storage.url);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /session expired/i);
  } finally {
    await storage.close();
  }
});

// ── A token that expires while the bytes are still moving ───────────────────
//
// F80. The access token was read ONCE, before the transfer, and baked into the
// tus options as a fixed Authorization header. Storage checks the JWT's exp on
// every PATCH, so the first request after that token expired came back 400
// '"exp" claim timestamp check failed', which tus does not retry (a 4xx), and
// the teacher was told their session had expired -- during an upload that had
// every right to continue. Nothing was wrong with the session: auth-js had
// refreshed it, and getSession() would have handed back the new token. The
// proxy mints tokens with as little as a few minutes left, and the deploy
// README tells IT to cut the lifetime to 15 minutes, so on a Ladakh link this
// was every phone video.

// Storage's answer to an expired token (local stack, 2026-09-24).
const EXPIRED = JSON.stringify({
  statusCode: "403",
  code: "AccessDenied",
  error: "Unauthorized",
  message: '"exp" claim timestamp check failed',
});
const CHUNK = 256; // BYTES is 1 KiB: the creation request carries one chunk, three PATCHes the rest

function resetTokens(current = TEST_ACCESS_TOKEN): ReturnType<typeof testTokens> {
  const t = testTokens();
  t.current = current;
  t.refreshed = undefined;
  t.refreshCalls = 0;
  return t;
}

test("every request carries the session's CURRENT token, so a refresh mid-upload is picked up", async () => {
  const tokens = resetTokens("token-a");
  const storage = await fakeStorage(undefined, (s) => {
    if (s.method === "POST") {
      // Token A is accepted for the creation request and expires right after
      // it; the session has been refreshed, so getSession() now answers B.
      tokens.current = "token-b";
      return null;
    }
    return s.headers.authorization === "Bearer token-b" ? null : { status: 400, body: EXPIRED };
  });
  try {
    const result = await upload(storage.url, resumeStore([]).store, CHUNK);
    assert.deepEqual(result, { ok: true }, "the session is fine; the upload must not stop at the old token's exp");
    const patches = storage.seen.filter((s) => s.method === "PATCH");
    assert.ok(patches.length >= 3, "the rest of the file went up in PATCHes");
    assert.ok(patches.every((p) => p.headers.authorization === "Bearer token-b"), "each PATCH asks the session for its token");
  } finally {
    resetTokens();
    await storage.close();
  }
});

test("a token Storage calls expired is refreshed once and the upload continues", async () => {
  // The browser still believes token A is valid (its clock, or a refresh that
  // has not run yet); Storage does not. One forced refresh mints B.
  const tokens = resetTokens("token-a");
  tokens.refreshed = "token-b";
  let created = false;
  const storage = await fakeStorage(undefined, (s) => {
    if (s.method === "POST" && !created) {
      created = true;
      return null;
    }
    return s.headers.authorization === "Bearer token-b" ? null : { status: 400, body: EXPIRED };
  });
  try {
    const result = await upload(storage.url, resumeStore([]).store, CHUNK);
    assert.deepEqual(result, { ok: true });
    assert.equal(tokens.refreshCalls, 1, "one refresh, not one per request");
  } finally {
    resetTokens();
    await storage.close();
  }
});

test("a token refused again after a refresh is reported as an expired session, without looping", async () => {
  const tokens = resetTokens("token-a");
  tokens.refreshed = "token-b";
  const storage = await fakeStorage(undefined, () => ({ status: 400, body: EXPIRED }));
  try {
    const result = await upload(storage.url, resumeStore([]).store, CHUNK);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /session expired/i, "here the session really is gone, and signing in again is the fix");
    assert.equal(tokens.refreshCalls, 1, "one forced refresh; a refusal of the fresh token is final");
    assert.ok(storage.seen.length <= 2, `bounded: ${storage.seen.length} requests`);
  } finally {
    resetTokens();
    await storage.close();
  }
});

// ── What a teacher is told when the link drops ───────────────────────────────
//
// A browser XHR that fails at the network level gives tus a bare ProgressEvent,
// so the error tus reports carries the request, NO response, and no text worth
// matching: "tus: failed to upload chunk at offset 6291456, caused by [object
// ProgressEvent], originated from request (method: PATCH, url: ..., response
// code: n/a ...)". Observed in the production build with a dropped link: the
// tray said "Upload failed. Please try again" instead of telling the teacher the
// upload can be resumed. And because the message embeds the upload URL, whose
// id is base64, a status regex over the text could read "413" or "401" out of
// the id and call a dropped link "too large" or "session expired".

const DetailedError = (
  createRequire(new URL("../../apps/web/package.json", import.meta.url))("tus-js-client") as {
    DetailedError: new (message: string, cause?: unknown, req?: unknown, res?: unknown) => Error;
  }
).DetailedError;

const request = (method: string, url: string) => ({ getHeader: () => undefined, getMethod: () => method, getURL: () => url });
const response = (status: number, body: string) => ({ getStatus: () => status, getBody: () => body });
// An upload id that happens to contain both "413" and "401".
const UPLOAD_URL = "http://127.0.0.1:55321/storage/v1/upload/resumable/dmlkZW9zLW9yaWdpbmFs413LzQwMTAx401";

test("a dropped connection is reported as one, with how to resume -- whatever digits the upload id contains", async () => {
  const { uploadErrorMessage } = await tusUpload();
  const dropped = new DetailedError("tus: failed to upload chunk at offset 6291456", { toString: () => "[object ProgressEvent]" }, request("PATCH", UPLOAD_URL), null);
  assert.match(uploadErrorMessage(dropped), /connection dropped/i);
  assert.match(uploadErrorMessage(dropped), /same file to resume/i, "resuming is the point of tus on a 2G link; the teacher must be told it is possible");
});

test("the classification reads the response, not the text of the URL", async () => {
  const { uploadErrorMessage } = await tusUpload();
  const at = (status: number, body: string) =>
    uploadErrorMessage(new DetailedError("tus: unexpected response while uploading chunk", null, request("PATCH", UPLOAD_URL), response(status, body)));
  assert.match(at(413, "Payload too large"), /too large/i);
  assert.match(at(403, "new row violates row-level security policy"), /refused/i);
  assert.match(at(400, '{"statusCode":"403","error":"Unauthorized","message":"jwt expired"}'), /session expired/i);
  assert.match(at(500, "internal error"), /Upload failed/, "an upload id containing 413 and 401 is not a size or session problem");
});
