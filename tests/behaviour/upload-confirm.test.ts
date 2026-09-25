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

/**
 * Run `body` against the real MobileUploadRunner. extractFirstFrame builds a
 * <video> to draw a thumbnail; there is no DOM here, so it is handed one that
 * fails to decode, which the runner handles.
 */
async function withMobileRunner(
  body: (r: {
    pick: (file: typeof FILE) => Promise<void>;
    press: (label: string) => Promise<void>;
    screen: () => string;
  }, routerCalls: string[], unhandled: unknown[]) => Promise<void>,
) {
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
      const { MobileUploadRunner } = await import("../../apps/web/src/components/video/MobileUploadRunner.tsx");
      const m = mount(MobileUploadRunner as (p: unknown) => unknown, {});
      const els = () => hostElements(m.rerender());
      const screen = () => textOf(els().find((el) => el.props["data-testid"] === "mobile-upload-runner") ?? null);
      const pick = async (file: typeof FILE) => {
        const input = els().find((el) => el.props["data-testid"] === "gallery-input")!;
        await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [file], value: "x" } });
        await drain();
      };
      const press = async (label: string) => {
        const button = els().find((el) => el.type === "button" && textOf(el).trim() === label);
        assert.ok(button, `a "${label}" button on: ${screen()}`);
        await (button.props.onClick as () => Promise<void> | void)();
        await drain();
      };
      await body({ pick, press, screen }, routerCalls, unhandled);
    });
  } finally {
    if (!hadDocument) delete g.document;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
}

test("mobile: a completion call that fails leaves the progress screen, and Retry re-confirms without re-uploading", async () => {
  await withMobileRunner(async ({ pick, press, screen }, routerCalls, unhandled) => {
    const u = script({ complete: dropped });
    await pick(FILE);
    await press("Start upload");

    assert.deepEqual(unhandled, [], "a dropped completion POST must not be an unhandled rejection");
    assert.doesNotMatch(screen(), /Uploading/, "not stuck on the progress screen at 100%");
    assert.match(screen(), /could not confirm/i, screen());

    u.calls = [];
    u.complete = async () => ({ ok: true });
    await press("Retry");
    assert.deepEqual(u.calls, [`complete:${RESERVATION.submissionId}`], "the file is already stored: Retry must not upload it again");
    assert.match(screen(), /Uploaded/);
    assert.ok(routerCalls.includes("push:/uploads"));
  });
});

// The unconfirmed submission belongs to ONE upload. Once the teacher has gone
// back and started another file, a Retry of that other file's failure must
// upload it -- confirming the earlier submission instead would report
// "Uploaded" for a file that was never sent.
test("mobile: after an unconfirmed upload, Retry of a different file's failure uploads that file", async () => {
  await withMobileRunner(async ({ pick, press, screen }, routerCalls) => {
    const u = script({ complete: dropped });
    await pick(FILE);
    await press("Start upload");
    assert.match(screen(), /could not confirm/i, "file A is stored but unconfirmed");

    const FILE_B = { name: "second-lesson.mp4", size: 4321, type: "video/mp4" };
    const RESERVATION_B = { ...RESERVATION, submissionId: "7c1e9a52-3b0d-4e6f-9a8b-2d4c6e8f0a1b", objectKey: "u/7c1e9a52.mp4" };
    const begun: string[] = [];
    u.begin = async (input) => {
      begun.push((input as { filename: string }).filename);
      return dropped();
    };
    await press("Back");
    await pick(FILE_B);
    await press("Start upload");
    assert.match(screen(), /Upload failed/, "B's reservation call failed");

    u.calls = [];
    await press("Retry");
    assert.deepEqual(u.calls, ["begin"], "Retry starts B's upload again; it does not confirm A");
    assert.deepEqual(begun, [FILE_B.name, FILE_B.name]);
    assert.doesNotMatch(screen(), /Uploaded/, "B was never sent");
    assert.ok(!routerCalls.includes("push:/uploads"));

    u.calls = [];
    u.begin = async () => RESERVATION_B;
    u.complete = async () => ({ ok: true });
    await press("Retry");
    assert.deepEqual(u.calls, ["begin", "tus", `complete:${RESERVATION_B.submissionId}`]);
    assert.match(screen(), /Uploaded/);
  });
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
  }
});

/** What the worker's logger writes (to stderr) while `body` runs. */
async function workerLogLines(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    const s = String(chunk);
    if (s.startsWith("[worker]")) lines.push(s.trim());
    return write(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    await body();
  } finally {
    process.stderr.write = write;
  }
  return lines;
}

// The reconciler asked the same question with `stat(...).catch(() => null)`, so
// during a Storage outage a stored upload older than the abandon window was
// failed as if its object were missing -- the same confusion, in the worker.
//
// W3-60: and not failing it has no end. The abandon rule is reached only
// through an answer, so an upload whose stat keeps throwing stays 'received'
// for good -- which is only acceptable if somebody is told. It used to be a
// count in an info line.
const UNANSWERED = [
  { ageHours: (h: number) => h + 1, level: /\]\[(warn|error)\]/, what: "and says so" },
  { ageHours: (h: number) => 2 * h + 1, level: /\]\[error\]/, what: "and says so as an error once it has lasted past any outage" },
];
for (const c of UNANSWERED) {
  test(`the reconciler leaves an upload alone when Storage does not answer, rather than failing it as missing -- ${c.what}`, { skip: needsDatabase() }, async () => {
    mock.timers.reset();
    const pg = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
    await pg.connect();
    const T = tag("cnf");
    const userId = (
      await pg.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [`${T}@example.test`, T])
    ).rows[0].id as string;
    try {
      await import("./_ui.js");
      const { beginUpload } = await import("../../apps/web/src/lib/video/upload.ts");
      const { UPLOAD_ABANDON_AFTER_HOURS } = await import("../../packages/db/src/uploads.ts");
      const { reconcileStalledUploads } = await import("../../apps/worker/src/reconcile-uploads.ts");
      const r = await beginUpload({ userId, filename: "a.mp4", sizeBytes: 1000, contentType: "video/mp4", contextType: "generic" });
      assert.ok(!("error" in r));
      const age = c.ageHours(UPLOAD_ABANDON_AFTER_HOURS);
      await pg.query(`UPDATE video_submissions SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [r.submissionId, age]);
      const lines = await workerLogLines(() =>
        reconcileStalledUploads({
          stat: async () => {
            throw new Error("upstream 503");
          },
        }),
      );
      const row = (
        await pg.query(`SELECT v.status, f.status AS "fileStatus" FROM video_submissions v JOIN files f ON f.id = v.file_id WHERE v.id = $1`, [r.submissionId])
      ).rows[0];
      assert.deepEqual([row.status, row.fileStatus], ["received", "uploading"], "no answer this sweep; the next one decides");

      const said = lines.find((l) => /Storage did not answer/.test(l));
      assert.ok(said, `nothing said that uploads are stuck behind Storage:\n${lines.join("\n")}`);
      assert.match(said, c.level);
      const fields = JSON.parse(said.slice(said.indexOf("{"))) as { unanswered: number; oldestHours: number; err: string };
      assert.ok(fields.unanswered >= 1);
      // Other files' rows share this table; this one is at least this old.
      assert.ok(fields.oldestHours >= age, `oldestHours ${fields.oldestHours} < ${age}`);
      assert.match(fields.err, /upstream 503/);
    } finally {
      await pg.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = $1`, [userId]);
      await pg.query(`DELETE FROM files WHERE owner_user_id = $1`, [userId]);
      await pg.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await pg.end();
      // The app's pool cannot be used again once ended: only after the last.
      if (c === UNANSWERED[UNANSWERED.length - 1]) {
        const { closeAppDb } = await import("./_server-actions.js");
        await closeAppDb();
      }
    }
  });
}
