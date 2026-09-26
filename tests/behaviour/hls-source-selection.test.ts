// Which engine the video player hands its <video> element to -- executed.
//
// ── THE DEFECT (FR-01) ───────────────────────────────────────────────────────
//
// HlsPlayer used the browser's native HLS whenever
// video.canPlayType("application/vnd.apple.mpegurl") was non-empty, and
// current desktop and Android Chrome answer "maybe". The playlist comes from
// the app's origin (/api/media/playlist/<id>) but every segment line in it is
// a signed Storage URL on another origin, and Chrome's native player failed
// the stream with MEDIA_ERR_SRC_NOT_SUPPORTED: no transcoded video played in
// Chrome, for any role. hls.js -- which the player ships and which fetches
// segments with CORS, which Storage answers -- was never tried. The failure
// message then blamed the connection, and was not announced to a screen
// reader.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL HlsPlayer, mounted with its effect (mount() in _ui.ts), handed a
// fake <video> through the ref it renders, exactly as the recovery tests in
// hls-playback-recovery.test.ts do. hls.js is the browser boundary here:
// Hls.isSupported() asks for Media Source Extensions, which Node lacks, so
// `import("hls.js")` resolves to _stubs/hls-js.mts, whose answer the test sets
// and whose instances record what the player asked of them. MSE itself is a
// global the player reads before fetching the hls.js bundle at all.
//
// THE REAL-BROWSER CHECK, which no tier here can run: in Chromium, open
// /videos/<id> for a ready video as a viewer allowed to see it. The <video>'s
// currentSrc is a blob: URL (hls.js via MSE, not the playlist URL); the
// network panel shows the master playlist and each ?variant= playlist from
// the app answering 200, then segment GETs to the Storage origin answering
// 200 with Access-Control-Allow-Origin; video.error stays null and pressing
// play advances currentTime.

import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import "./_ui.js";
import { fakeHls } from "./_stubs/hls-js.mts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "hls.js") {
      return { url: new URL("./_stubs/hls-js.mts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const SRC = "/api/media/playlist/v1";
const g = globalThis as Record<string, unknown>;

// Load the stand-in once up front, as the module the player's import() gets:
// its first load is a transform that takes longer than settle() waits, and
// the player's own import() of it then resolves within a few ticks.
before(async () => {
  await import("hls.js");
});

afterEach(() => {
  delete g.MediaSource;
  fakeHls().made = [];
  fakeHls().supported = true;
});

/** A <video> element as far as the player touches it; `nativeHls` is its canPlayType answer. */
class FakeVideo {
  currentTime = 0;
  playbackRate = 1;
  srcSets: string[] = [];
  private _src = "";
  private listeners = new Map<string, Set<() => void>>();
  constructor(private readonly nativeHls: string) {}
  canPlayType(type: string) {
    return type === "application/vnd.apple.mpegurl" ? this.nativeHls : "";
  }
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.srcSets.push(v);
  }
  load() {}
  play() {
    return Promise.resolve();
  }
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
}

/** A browser: whether it has MSE, what hls.js says of it, what its <video> says of HLS. */
type Browser = { mse: boolean; hlsSupported: boolean; nativeHls: string };
const CHROME: Browser = { mse: true, hlsSupported: true, nativeHls: "maybe" };
const FIREFOX: Browser = { mse: true, hlsSupported: true, nativeHls: "" };
const IOS_16: Browser = { mse: false, hlsSupported: false, nativeHls: "maybe" };

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Mount the real player in `browser`, hand it the element, and let the effect run. */
async function open(browser: Browser) {
  if (browser.mse) g.MediaSource = class {};
  fakeHls().supported = browser.hlsSupported;
  const { mount, hostElements } = await import("./_ui.js");
  const { HlsPlayer } = await import("../../apps/web/src/components/video/HlsPlayer.tsx");
  const video = new FakeVideo(browser.nativeHls);
  const m = mount(HlsPlayer as (p: unknown) => unknown, { src: SRC, watermark: "Teacher · now", videoId: "v1" }, { effects: true });
  const el = hostElements(m.tree).find((e) => e.type === "video")!;
  (el.props.ref as { current: unknown }).current = video;
  m.rerender(); // the effect runs again, now with an element
  const srcBeforeAnyAwait = video.src;
  await settle();
  return { m, video, el, srcBeforeAnyAwait };
}

/** The message laid over the player, and the element carrying it. */
async function overlay(tree: unknown) {
  const { hostElements, textOf } = await import("./_ui.js");
  const box = hostElements(tree).find((e) => e.type === "div" && /rgba\(0,\s*0,\s*0,\s*0\.7\)/.test(JSON.stringify(e.props.style ?? {})));
  return box ? { role: box.props.role, text: textOf(box) } : null;
}

test("Chrome (canPlayType says 'maybe', MSE present): hls.js plays the stream, not the native player", async () => {
  const { m, video } = await open(CHROME);
  try {
    const made = fakeHls().made;
    assert.equal(made.length, 1, `native HLS was chosen: video.src was set to ${JSON.stringify(video.srcSets)}`);
    assert.deepEqual(made[0]!.sources, [SRC], "hls.js loads the app's playlist route");
    assert.equal(made[0]!.media, video, "hls.js is attached to the player's own element");
    assert.deepEqual(video.srcSets, [], "the element must not ALSO be pointed at the playlist natively");
    assert.equal(await overlay(m.rerender()), null, "no message over a stream that is loading");
  } finally {
    m.unmount();
  }
  assert.ok(fakeHls().made[0]!.destroyed, "unmounting tears hls.js down");
});

test("Firefox (no native HLS, MSE present): hls.js, as before", async () => {
  const { m, video } = await open(FIREFOX);
  m.unmount();
  assert.equal(fakeHls().made.length, 1);
  assert.deepEqual(video.srcSets, []);
});

test("iPhone without MSE (iOS before 17.1): native HLS, attached at once without fetching hls.js first", async () => {
  const { m, video, srcBeforeAnyAwait } = await open(IOS_16);
  m.unmount();
  assert.equal(srcBeforeAnyAwait, SRC, "native playback waited on the hls.js bundle, which cannot run here");
  assert.deepEqual(video.srcSets, [SRC]);
  assert.equal(fakeHls().made.length, 0);
});

test("MSE present but hls.js cannot use it: the native player, when there is one", async () => {
  const { m, video } = await open({ mse: true, hlsSupported: false, nativeHls: "maybe" });
  m.unmount();
  assert.equal(fakeHls().made.length, 0);
  assert.deepEqual(video.srcSets, [SRC]);
});

test("a browser that can play HLS neither way: one message naming the browser, announced (role=alert)", async () => {
  for (const browser of [
    { mse: false, hlsSupported: false, nativeHls: "" },
    { mse: true, hlsSupported: false, nativeHls: "" },
  ]) {
    const { m, video } = await open(browser);
    const shown = await overlay(m.rerender());
    m.unmount();
    assert.ok(shown, `no message (mse=${browser.mse})`);
    assert.equal(shown.role, "alert", "the failure is not announced to assistive technology");
    assert.match(shown.text, /browser/i, "the message must say it is this browser, not the connection");
    assert.doesNotMatch(shown.text, /connection/i);
    assert.deepEqual(video.srcSets, []);
    fakeHls().made = [];
  }
});

test("Chrome, signed out mid-video: hls.js's 401 reaches the viewer once, announced, with no rebuild loop", async (t) => {
  const { PLAYBACK_FAILURE_MESSAGES } = await import("../../apps/web/src/lib/video/playback-recovery.ts");
  const { m } = await open(CHROME);
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const [hls] = fakeHls().made;
    assert.ok(hls, "hls.js was not used in Chrome");
    const fatal = { fatal: true, type: "networkError", details: "manifestLoadError", response: { code: 401 } };
    hls.emit("hlsError", fatal);
    hls.emit("hlsError", fatal);
    t.mock.timers.tick(60_000);
    await settle();
    // Counted before re-rendering: mount()'s useCallback does not memoise,
    // so a re-render re-runs the effect where React would not.
    assert.equal(fakeHls().made.length, 1, "the player rebuilt hls.js after a failure a re-sign cannot fix");
    assert.ok(hls.destroyed);
    const shown = await overlay(m.rerender());
    assert.equal(shown?.role, "alert");
    assert.match(shown?.text ?? "", new RegExp(PLAYBACK_FAILURE_MESSAGES.signed_out.slice(0, 20)));
  } finally {
    m.unmount();
  }
});

test("the <video> requests media with CORS, so a native player may use Storage's cross-origin segments", async () => {
  const { renderSync, h, openingTags, attr } = await import("./_ui.js");
  const { HlsPlayer } = await import("../../apps/web/src/components/video/HlsPlayer.tsx");
  const [tag] = openingTags(renderSync(h(HlsPlayer, { src: SRC, watermark: "Teacher · now" })), "video");
  assert.ok(tag);
  assert.equal(attr(tag, "crossorigin"), "anonymous");
});
