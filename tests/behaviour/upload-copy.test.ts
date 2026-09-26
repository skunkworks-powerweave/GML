// What the upload surfaces tell people is what the product does -- executed:
// /uploads rendered against Postgres, and the phone flow and the /videos upload
// dialog driven through their own handlers.
//
// ── THE DEFECT (F13, the upload surfaces' share) ─────────────────────────────
//
//   "Max file 500 MB"         hard-coded, while the cap is the programme
//                             setting videoMaxUploadMb (10 to 2000), which
//                             beginUpload enforces. Raised to 750, the card
//                             still said 500.
//   "Record in-app"           a desktop card promising "Saves to your phone
//                             first; uploads when you have wifi". It linked to
//                             the same file picker as "Upload here"; nothing
//                             records, saves offline or waits for wifi.
//   "Three ways to submit"    counting that card.
//   "We'll notify your        the phone flow's success screen. Nothing notifies
//    mentor when it's ready"  anyone when a transcode finishes.
//   "a programme admin can    the /videos dialog. No screen re-links a video;
//    attach them from the     the ingest log itself says so.
//    WhatsApp ingest log"
//   "— spec 168"              an internal spec number in user copy.

import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { signIn, outcome, closeAppDb } from "./_server-actions.js";
import { render, withAppRouter, request, decodeEntities, mount, hostElements, textOf } from "./_ui.js";
import { needsDatabase, withClient } from "./_harness.js";
import { uploadScript } from "./_stubs/upload-actions.ts";
import { randomUUID } from "node:crypto";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

// The upload controls' two server actions and the tus transfer, replaced for
// those components only (as upload-confirm.test.ts does).
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

const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

async function uploadsPageText() {
  // A signed-in user with nothing open to choose from: the page shows its
  // upload card at once.
  signIn({ id: randomUUID(), role: "programme_admin" });
  request.headers = {};
  const { default: UploadsPage } = await import("../../apps/web/src/app/(authenticated)/uploads/page.tsx");
  const r = await outcome(async () => render(withAppRouter(await UploadsPage({ searchParams: Promise.resolve({}) }))));
  signIn(null);
  assert.equal(r.kind, "returned", JSON.stringify(r));
  return text(String((r as { value: unknown }).value));
}

test("F13: the upload card states the programme's own size limit", { skip }, async () => {
  await withClient(async (c) => {
    const [{ video_max_upload_mb: before }] = (await c.query(`SELECT video_max_upload_mb FROM system_settings`)).rows;
    // Raised, never lowered: other test files reserve uploads concurrently.
    await c.query(`UPDATE system_settings SET video_max_upload_mb = 750`);
    try {
      const t = await uploadsPageText();
      assert.match(t, /Max file 750 MB/);
      assert.doesNotMatch(t, /500 MB/);
    } finally {
      await c.query(`UPDATE system_settings SET video_max_upload_mb = $1`, [before]);
    }
  });
});

test("F13: /uploads promises no in-app recorder, offline save or wifi wait it does not have", { skip }, async () => {
  const t = await uploadsPageText();
  assert.doesNotMatch(t, /Record in-app/);
  assert.doesNotMatch(t, /when you have wifi/i);
  assert.doesNotMatch(t, /Three ways/i);
});

const appRouter = () =>
  (createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "next/dist/shared/lib/app-router-context.shared-runtime",
  ) as { AppRouterContext: { _currentValue: unknown } }).AppRouterContext;

test("F13: the phone flow's success screen does not promise that the mentor is notified", async () => {
  const ctx = appRouter();
  const previous = ctx._currentValue;
  ctx._currentValue = (withAppRouter(null, []) as { props: { value: unknown } }).props.value;
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
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const u = uploadScript();
    u.calls = [];
    u.begin = async () => ({
      ok: true,
      submissionId: randomUUID(),
      bucket: "videos-original",
      objectKey: "u/x.mp4",
      chunkBytes: 6 * 1024 * 1024,
      supabase: { url: "http://storage.test", anonKey: "k" },
    });
    u.complete = async () => ({ ok: true });
    const { MobileUploadRunner } = await import("../../apps/web/src/components/video/MobileUploadRunner.tsx");
    const m = mount(MobileUploadRunner as (p: unknown) => unknown, {});
    const els = () => hostElements(m.rerender());
    const drain = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    const input = els().find((el) => el.props["data-testid"] === "gallery-input")!;
    await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [{ name: "a.mp4", size: 10, type: "video/mp4" }], value: "x" } });
    await drain();
    await (els().find((el) => el.props["data-testid"] === "start-upload")!.props.onClick as () => Promise<void>)();
    await drain();
    const screen = textOf(els().find((el) => el.props["data-testid"] === "mobile-upload-runner") ?? null);
    assert.match(screen, /Uploaded/, screen);
    assert.doesNotMatch(screen, /notify/i, "nothing notifies anyone when a transcode finishes");
  } finally {
    mock.timers.reset();
    ctx._currentValue = previous;
    if (!hadDocument) delete g.document;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
});

test("F13: the /videos upload dialog claims no re-link it does not have, and cites no spec", async () => {
  const { UploadModal } = await import("../../apps/web/src/components/video/UploadModal.tsx");
  const m = mount(UploadModal as (p: unknown) => unknown, { whatsappPhone: "+919999999999", videoDefaultQuality: "480p" });
  const open = hostElements(m.rerender()).find((el) => el.props["data-testid"] === "upload-trigger")!;
  (open.props.onClick as () => void)();
  const dialog = textOf(hostElements(m.rerender()).find((el) => el.props["data-testid"] === "upload-modal") ?? null);
  assert.match(dialog, /Send via WhatsApp/, "the dialog is open");
  assert.doesNotMatch(dialog, /attach them from the WhatsApp ingest log/);
  assert.doesNotMatch(dialog, /spec \d+/i);
});
