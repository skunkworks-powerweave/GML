// The upload module does not load the browser Supabase client until an upload
// actually starts -- executed.
//
// ── THE DEFECT (F146) ────────────────────────────────────────────────────────
//
// lib/video/tus-upload.ts imported accessToken() from lib/supabase/browser
// STATICALLY. That module pulls in @supabase/ssr and supabase-js (auth,
// realtime, storage, postgrest): about 236 KB raw / 63 KB gzipped, measured in
// the production build, in the first-load JavaScript of every page that mounts
// an uploader -- /uploads and /videos -- including for viewers who never
// upload. On the teacher's phone that was about a quarter of /uploads' JS.
// tus-js-client beside it was already loaded lazily; the token lookup was not.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// In the bundler a dynamic import() is a separate chunk fetched when it runs,
// and a static import is part of the importing chunk. The same distinction is
// visible at runtime: this process imports the real tus-upload.ts and asks
// whether the browser client module (the stub _ui.ts maps it to, which records
// its own evaluation) has been evaluated. This file deliberately imports
// nothing that loads that stub itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";

const loaded = () => (globalThis as Record<string, unknown>).__gmlSupabaseBrowserLoaded === true;

test("importing the upload module does not load the browser Supabase client", async () => {
  assert.equal(loaded(), false, "precondition: nothing has loaded it yet");
  const { startResumableUpload } = await import("../../apps/web/src/lib/video/tus-upload.ts");
  assert.equal(typeof startResumableUpload, "function");
  assert.equal(loaded(), false, "the page that mounts the uploader must not pay for supabase-js up front");

  // Not configured: refused before anything is loaded.
  const errors: string[] = [];
  await startResumableUpload({
    file: Object.assign(Buffer.from("x"), { type: "video/mp4" }) as unknown as File,
    bucket: "videos-original",
    objectKey: "k",
    contentType: "video/mp4",
    chunkBytes: 6 * 1024 * 1024,
    supabase: { url: "", anonKey: "" },
    onProgress: () => undefined,
    onError: (m) => void errors.push(m),
    onSuccess: () => undefined,
  });
  assert.match(errors[0] ?? "", /not configured/);
  assert.equal(loaded(), false);
});
