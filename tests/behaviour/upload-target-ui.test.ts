// The upload controls send what the page told them the video is for --
// executed: the real UploadProgress and MobileUploadRunner, driven through
// their own handlers (see upload-confirm.test.ts for the mechanics).
//
// ── THE DEFECT (F18) ─────────────────────────────────────────────────────────
//
// MobileUploadRunner had a cycle prop, `activeCycleCode`, that no page passed,
// and it could not have worked if one had: it sent the CODE as contextId
// (the server's uuid check answers that with a 404, so the reservation
// failed), prefilled the caption as `OBS-${code}` -- OBS-OBS-2026-004, since
// codes are stored with their prefix -- and pre-filled WhatsApp with
// `#${code}`. So a phone upload could only ever be 'generic'.
//
// Both controls now take the target the page resolved: its context type, its
// id, and for a quarterly video its quarter.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { mount, hostElements, textOf, withAppRouter } from "./_ui.js";
import { uploadScript } from "./_stubs/upload-actions.ts";

// The two server actions and the tus transfer are the components' boundaries;
// both are replaced for them only, exactly as upload-confirm.test.ts does.
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

const CYCLE_ID = "5d7f2a4e-0b1c-4d3e-8f9a-1b2c3d4e5f60";
const PAIRING_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const FILE = { name: "lesson.mp4", size: 1234, type: "video/mp4" };

function recordBegins() {
  const u = uploadScript();
  const begun: unknown[] = [];
  u.calls = [];
  u.begin = async (input) => {
    begun.push(input);
    return { ok: false, error: "stop here" };
  };
  u.complete = async () => ({ ok: true });
  return begun;
}

async function drain() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(60_000);
  }
}

const appRouter = () =>
  (createRequire(new URL("../../apps/web/package.json", import.meta.url))(
    "next/dist/shared/lib/app-router-context.shared-runtime",
  ) as { AppRouterContext: { _currentValue: unknown } }).AppRouterContext;

async function withClientEnv(body: () => Promise<void>) {
  const ctx = appRouter();
  const previous = ctx._currentValue;
  ctx._currentValue = (withAppRouter(null, []) as { props: { value: unknown } }).props.value;
  const g = globalThis as Record<string, unknown>;
  const hadDocument = "document" in g;
  const { createObjectURL, revokeObjectURL } = URL;
  // extractFirstFrame draws a thumbnail through a <video>; this one fails to
  // decode, which the runner handles.
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
    await body();
  } finally {
    mock.timers.reset();
    ctx._currentValue = previous;
    if (!hadDocument) delete g.document;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
}

test("F18: the phone flow reserves against the cycle's id, and pre-fills its code once, not twice", async () => {
  await withClientEnv(async () => {
    const begun = recordBegins();
    const { MobileUploadRunner } = await import("../../apps/web/src/components/video/MobileUploadRunner.tsx");
    const m = mount(MobileUploadRunner as (p: unknown) => unknown, {
      whatsappPhone: "+919999999999",
      target: { contextType: "observation_cycle", contextId: CYCLE_ID, quarter: null, whatsappText: "OBS-2026-004" },
    });
    const els = () => hostElements(m.rerender());
    const wa = els().find((el) => el.props["data-testid"] === "whatsapp-fallback-link");
    assert.equal(new URL(String(wa!.props.href)).searchParams.get("text"), "OBS-2026-004", "the exact code, no '#' and no second OBS-");

    const input = els().find((el) => el.props["data-testid"] === "gallery-input")!;
    await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [FILE], value: "x" } });
    await drain();
    const caption = els().find((el) => el.props["data-testid"] === "caption-textarea")!;
    assert.doesNotMatch(String(caption.props.value), /OBS-OBS-/);
    const start = els().find((el) => el.props["data-testid"] === "start-upload")!;
    await (start.props.onClick as () => Promise<void>)();
    await drain();
    assert.equal(begun.length, 1);
    const b = begun[0] as Record<string, unknown>;
    assert.deepEqual([b.contextType, b.contextId, b.quarter], ["observation_cycle", CYCLE_ID, null], "the id the server checks, not the code");
  });
});

test("F18: with no target the phone flow is generic, and says nothing about routing by caption", async () => {
  await withClientEnv(async () => {
    const begun = recordBegins();
    const { MobileUploadRunner } = await import("../../apps/web/src/components/video/MobileUploadRunner.tsx");
    const m = mount(MobileUploadRunner as (p: unknown) => unknown, { whatsappPhone: null });
    const els = () => hostElements(m.rerender());
    const input = els().find((el) => el.props["data-testid"] === "gallery-input")!;
    await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [FILE], value: "x" } });
    await drain();
    const screen = textOf(els().find((el) => el.props["data-testid"] === "mobile-upload-runner") ?? null);
    assert.doesNotMatch(screen, /use OBS-|TB-<uuid>|MM-<uuid>/, "a direct upload is not routed by what the caption says");
    const start = els().find((el) => el.props["data-testid"] === "start-upload")!;
    await (start.props.onClick as () => Promise<void>)();
    await drain();
    assert.equal((begun[0] as { contextType: string }).contextType, "generic");
    assert.equal((begun[0] as { contextId: unknown }).contextId, null);
  });
});

test("F50: the desktop tray reserves a quarterly video with its quarter", async () => {
  await withClientEnv(async () => {
    const begun = recordBegins();
    const { UploadProgress } = await import("../../apps/web/src/components/video/UploadProgress.tsx");
    const m = mount(UploadProgress as (p: unknown) => unknown, { contextType: "mentee_quarterly", contextId: PAIRING_ID, quarter: 1 });
    const input = hostElements(m.rerender()).find((el) => el.type === "input")!;
    await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [FILE], value: "x" } });
    await drain();
    assert.equal(begun.length, 1);
    const b = begun[0] as Record<string, unknown>;
    assert.deepEqual([b.contextType, b.contextId, b.quarter], ["mentee_quarterly", PAIRING_ID, 1]);
  });
});
