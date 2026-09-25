// The upload UI when a server round-trip fails -- executed.
//
// ── THE DEFECTS (F96) ────────────────────────────────────────────────────────
//
// A direct upload is bracketed by two server actions. On the desktop tray,
// `await beginUploadAction(...)` had no try/catch, and once tus finished the
// tray was set to "transcoding" and `void completeUploadAction(...).then(...)`
// ran with no .catch. A dropped connection on that last small POST -- easy on
// 2G after an hours-long transfer -- became an unhandled rejection: the tray
// said "transcoding" forever, with no error and no retry, and the completion
// was never re-sent. The mobile runner had the same shape and sat on its
// progress screen at 100%; its only Retry restarted the whole upload.
//
// Separately, statObject answered null for ANY Storage list error, and
// completeUpload maps null to object_missing, so a transient Storage 5xx told
// the teacher "We could not find the uploaded file" -- prompting a full
// re-upload of a file that was in fact stored.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL UploadProgress and MobileUploadRunner, driven through their own
// handlers with mount() (see _ui.ts). Only their boundaries are replaced: the
// two server actions (a network round-trip, scripted per test) and the tus
// transfer (executed for real in direct-upload.test.ts). Timers are mocked so
// the confirmation's backoff runs instantly. The server half runs the real
// statObject and completeUpload.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { Client } from "pg";
import { mount, hostElements, textOf, withAppRouter } from "./_ui.js";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { uploadScript } from "./_stubs/upload-actions.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const url = resolved.url.replace(/\\/g, "/");
    const fromUploadUi = /\/components\/video\/(UploadProgress|MobileUploadRunner)\.tsx$/.test(
      (context.parentURL ?? "").replace(/\\/g, "/"),
    );
    if (fromUploadUi && /\/app\/\(authenticated\)\/uploads\/actions\.ts$/.test(decodeURIComponent(url))) {
      return { url: new URL("./_stubs/upload-actions.ts", import.meta.url).href, shortCircuit: true };
    }
    if (fromUploadUi && /\/lib\/video\/tus-upload\.ts$/.test(url)) {
      return { url: new URL("./_stubs/tus-upload.ts", import.meta.url).href, shortCircuit: true };
    }
    return resolved;
  },
});

const RESERVATION = {
  ok: true,
  submissionId: "0f30f424-1654-4fd7-81ae-cb9925662052",
  bucket: "videos-original",
  objectKey: "u/0f30f424.mp4",
  chunkBytes: 6 * 1024 * 1024,
  supabase: { url: "http://storage.test", anonKey: "publishable-key" },
};
const FILE = { name: "lesson.mp4", size: 1234, type: "video/mp4" };
const dropped = () => Promise.reject(new TypeError("Failed to fetch"));

function script(s: { begin?: () => Promise<unknown>; complete?: () => Promise<unknown> }) {
  const u = uploadScript();
  u.calls = [];
  u.begin = s.begin ?? (async () => RESERVATION);
  u.complete = s.complete ?? (async () => ({ ok: true }));
  return u;
}

/** Let every pending promise and (mocked) timer run. */
async function drain() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(60_000);
  }
}

const appRouter = () =>
  (createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "next/dist/shared/lib/app-router-context.shared-runtime",
  ) as { AppRouterContext: { _currentValue: unknown } }).AppRouterContext;

/** Run `body` with mocked timers, a router in context, and rejections recorded. */
async function driving(body: (routerCalls: string[], unhandled: unknown[]) => Promise<void>) {
  const ctx = appRouter();
  const previous = ctx._currentValue;
  const routerCalls: string[] = [];
  ctx._currentValue = (withAppRouter(null, routerCalls) as { props: { value: unknown } }).props.value;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  mock.timers.reset(); // in case a failed test left them on
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await body(routerCalls, unhandled);
  } finally {
    mock.timers.reset();
    process.off("unhandledRejection", onUnhandled);
    ctx._currentValue = previous;
  }
}

async function tray() {
  const { UploadProgress } = await import("../../apps/web/src/components/video/UploadProgress.tsx");
  const m = mount(UploadProgress as (p: unknown) => unknown, { contextType: "generic" });
  const els = () => hostElements(m.rerender());
  const choose = async () => {
    const input = els().find((el) => el.type === "input")!;
    let threw: unknown;
    await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [FILE], value: "x" } }).catch(
      (err: unknown) => (threw = err),
    );
    await drain();
    return threw;
  };
  const row = () => textOf(els().find((el) => el.type === "li") ?? null);
  const retry = () => els().find((el) => el.type === "button" && /retry/i.test(textOf(el)));
  return { choose, row, retry };
}

// ── The desktop tray ─────────────────────────────────────────────────────────

test("tray: a reservation call that fails says so instead of rejecting", async () => {
  await driving(async (_r, unhandled) => {
    script({ begin: dropped });
    const t = await tray();
    const threw = await t.choose();
    assert.equal(threw, undefined, "the file picker's handler must not reject");
    assert.match(t.row(), /failed/i, `the tray row: ${t.row()}`);
    assert.match(t.row(), /connection|server/i, "and says why");
    assert.deepEqual(unhandled, []);
  });
});

test("tray: a completion call that fails is retried, then offers Retry -- and Retry only re-confirms", async () => {
  await driving(async (_r, unhandled) => {
    const u = script({ complete: dropped });
    const t = await tray();
    assert.equal(await t.choose(), undefined);
    assert.deepEqual(unhandled, [], "a dropped completion POST must not be an unhandled rejection");
    const confirms = u.calls.filter((c) => c.startsWith("complete:")).length;
    assert.ok(confirms > 1, `the completion is re-sent on its own (sent ${confirms} times)`);
    assert.ok(confirms <= 5, "and gives up after a few attempts");
    assert.doesNotMatch(t.row(), /transcoding/i, "not 'transcoding' forever: nothing was queued");
    assert.match(t.row(), /could not confirm/i, `the tray row: ${t.row()}`);
    const retry = t.retry();
    assert.ok(retry, "the teacher can retry the confirmation");

    u.calls = [];
    u.complete = async () => ({ ok: true });
    (retry.props.onClick as () => void)();
    await drain();
    assert.deepEqual(u.calls, [`complete:${RESERVATION.submissionId}`], "Retry confirms the same submission; it does not upload again");
    assert.match(t.row(), /transcoding/i);
  });
});

test("tray: a definitive refusal is shown at once, without retrying", async () => {
  await driving(async () => {
    const u = script({ complete: async () => ({ ok: false, error: "That upload could not be found." }) });
    const t = await tray();
    await t.choose();
    assert.equal(u.calls.filter((c) => c.startsWith("complete:")).length, 1);
    assert.match(t.row(), /could not be found/);
  });
});

// ── The mobile runner ────────────────────────────────────────────────────────

test("mobile: a completion call that fails leaves the progress screen, and Retry re-confirms without re-uploading", async () => {
  // extractFirstFrame builds a <video> to draw a thumbnail; there is no DOM
  // here, so it is handed one that fails to decode, which the runner handles.
  const g = globalThis as Record<string, unknown>;
  const hadDocument = "document" in g;
  const { createObjectURL, revokeObjectURL } = URL;
  g.document = {
    createElement: () => {
      const v: Record<string, unknown> = { removeAttribute: () => undefined, load: () => undefined };
      setImmediate(() => (v.onerror as (() => void) | undefined)?.());
      return v;
    },
  };
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
  try {
    await driving(async (routerCalls, unhandled) => {
      const u = script({ complete: dropped });
      const { MobileUploadRunner } = await import("../../apps/web/src/components/video/MobileUploadRunner.tsx");
      const m = mount(MobileUploadRunner as (p: unknown) => unknown, {});
      const els = () => hostElements(m.rerender());
      const byId = (id: string) => els().find((el) => el.props["data-testid"] === id);
      await (byId("gallery-input")!.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [FILE], value: "x" } });
      await (byId("start-upload")!.props.onClick as () => Promise<void>)();
      await drain();

      assert.deepEqual(unhandled, [], "a dropped completion POST must not be an unhandled rejection");
      const screen = () => textOf(els().find((el) => el.props["data-testid"] === "mobile-upload-runner") ?? null);
      assert.doesNotMatch(screen(), /Uploading/, "not stuck on the progress screen at 100%");
      assert.match(screen(), /could not confirm/i, screen());

      u.calls = [];
      u.complete = async () => ({ ok: true });
      const retry = els().find((el) => el.type === "button" && textOf(el) === "Retry");
      assert.ok(retry, "a Retry button");
      await (retry.props.onClick as () => Promise<void>)();
      await drain();
      assert.deepEqual(u.calls, [`complete:${RESERVATION.submissionId}`], "the file is already stored: Retry must not upload it again");
      assert.match(screen(), /Uploaded/);
      assert.ok(routerCalls.includes("push:/uploads"));
    });
  } finally {
    if (hadDocument) void 0;
    else delete g.document;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
});

// ── The server: a Storage error is not a missing file ────────────────────────

type ListAnswer = { data: unknown; error: unknown };
const fakeSupabase = (answer: ListAnswer) =>
  ({ storage: { from: () => ({ list: async () => answer }) } }) as never;

test("statObject tells a Storage error from an object that is not there", async () => {
  const { statObject } = await import("../../packages/shared/src/storage/client.ts");
  const key = "u/0f30f424.mp4";
  assert.equal(await statObject(fakeSupabase({ data: [], error: null }), "videos-original", key), null, "absent");
  assert.deepEqual(
    await statObject(fakeSupabase({ data: [{ name: "0f30f424.mp4", metadata: { size: 5, mimetype: "video/mp4" } }], error: null }), "videos-original", key),
    { size: 5, contentType: "video/mp4" },
  );
  await assert.rejects(
    statObject(fakeSupabase({ data: null, error: { message: "upstream 503" } }), "videos-original", key),
    "a Storage outage is not evidence the file is missing",
  );
});

test("completeUpload answers a Storage error as retryable, not as a missing file", { skip: needsDatabase() }, async () => {
  mock.timers.reset(); // pg's connection timeout needs the real setTimeout
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("cnf");
  const userId = (
    await c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [`${T}@example.test`, T])
  ).rows[0].id as string;
  try {
    await import("./_ui.js");
    const { beginUpload, completeUpload } = await import("../../apps/web/src/lib/video/upload.ts");
    const r = await beginUpload({ userId, filename: "a.mp4", sizeBytes: 1000, contentType: "video/mp4", contextType: "generic" });
    assert.ok(!("error" in r));
    const res = await completeUpload({
      submissionId: r.submissionId,
      userId,
      isAdmin: false,
      stat: async () => {
        throw new Error("upstream 503");
      },
    });
    assert.deepEqual(res, { ok: false, error: "storage_unavailable", status: 503 });
    const row = (await c.query(`SELECT status FROM video_submissions WHERE id = $1`, [r.submissionId])).rows[0];
    assert.equal(row.status, "received", "nothing moved: the next attempt can still complete it");
  } finally {
    await c.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = $1`, [userId]);
    await c.query(`DELETE FROM files WHERE owner_user_id = $1`, [userId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await c.end();
    const { closeAppDb } = await import("./_server-actions.js");
    await closeAppDb();
  }
});
