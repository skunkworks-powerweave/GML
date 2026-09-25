// What the video player does when playback dies -- executed.
//
// ── THE DEFECT (F08) ─────────────────────────────────────────────────────────
//
// On any fatal non-media hls.js error the player re-signed the playlist and
// rebuilt the Hls instance, which failed the same way, forever; the native
// branch (Safari, iOS, and desktop Chrome, which answers canPlayType "maybe")
// reassigned video.src on every `error` event. The only exit to an error
// message was a catch around refreshSrc, which cannot throw. So a persistent
// condition -- signed out (401), access revoked (404), output missing (502), a
// Storage outage -- became a black player with no message and a request storm:
// measured at 12-26 playlist requests a second per open tab on a 4xx, each an
// auth + DB lookup, and on a 2G phone its data and battery.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The recovery policy is pure and tested directly. The wiring -- what the
// player does with each decision on each branch -- is the real attachNative /
// attachHls from lib/video/playback-recovery.ts, which HlsPlayer's effect
// calls, driven with a fake <video> element and a fake hls.js instance (there
// is no DOM here). Timers are mocked so backoff runs instantly.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const recovery = () => import("../../apps/web/src/lib/video/playback-recovery.ts");

// ── The policy ───────────────────────────────────────────────────────────────

test("signed out, no access, output missing: the playlist route's answer decides, without a re-sign storm", async () => {
  const { createPlaybackRecovery } = await recovery();
  const at = 12;
  assert.deepEqual(createPlaybackRecovery().onFatal({ status: 401, source: "playlist", at }), { kind: "fail", reason: "signed_out" });
  assert.deepEqual(createPlaybackRecovery().onFatal({ status: 404, source: "playlist", at }), { kind: "fail", reason: "no_access" });
  assert.deepEqual(createPlaybackRecovery().onFatal({ status: 403, source: "playlist", at }), { kind: "fail", reason: "no_access" });
  const missing = createPlaybackRecovery();
  assert.equal(missing.onFatal({ status: 502, source: "playlist", at }).kind, "refresh", "one re-sign, in case it was transient");
  assert.deepEqual(missing.onFatal({ status: 502, source: "playlist", at }), { kind: "fail", reason: "unavailable" });
});

test("an expired segment URL or a flaky link is re-signed with backoff, a bounded number of times", async () => {
  const { createPlaybackRecovery } = await recovery();
  for (const status of [400, 503, 0, undefined]) {
    const p = createPlaybackRecovery();
    const delays: number[] = [];
    let action = p.onFatal({ status, source: "segment", at: 30 });
    while (action.kind === "refresh") {
      delays.push(action.delayMs);
      assert.ok(delays.length < 10, `status ${status}: unbounded`);
      action = p.onFatal({ status, source: "segment", at: 30 });
    }
    assert.deepEqual(action, { kind: "fail", reason: "generic" });
    assert.ok(delays.length >= 1 && delays.length <= 3, `status ${status}: ${delays.length} refreshes`);
    assert.ok(delays.every((d, i) => d > 0 && (i === 0 || d > delays[i - 1]!)), `backoff grows: ${delays}`);
  }
});

test("playing on past the failure restores the budget; stalling on the same spot does not", async () => {
  const { createPlaybackRecovery } = await recovery();
  const p = createPlaybackRecovery();
  const drain = () => {
    let n = 0;
    while (p.onFatal({ source: "segment", at: 100 }).kind === "refresh") {
      n += 1;
      assert.ok(n < 10, "unbounded");
    }
    return n;
  };
  const budget = drain();
  p.onProgress(100.2); // the refreshed stream loaded, but has not got past the failure
  assert.equal(p.onFatal({ source: "segment", at: 100 }).kind, "fail", "a stall at the same point is the same failure");
  p.onProgress(160); // a minute of real playback later
  assert.equal(p.onFatal({ source: "segment", at: 2400 }).kind, "refresh", "a later expiry is a new failure");
  assert.ok(budget > 0);
});

// ── The wiring ───────────────────────────────────────────────────────────────

class FakeVideo {
  currentTime = 0;
  loads = 0;
  srcSets = 0;
  private _src = "";
  private listeners = new Map<string, Set<() => void>>();
  /** When set, loading any source fails with an `error` event. */
  failing = true;
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.srcSets += 1;
    this.fail();
  }
  load() {
    this.loads += 1;
    this.fail();
  }
  private pending = false;
  // Setting src and then calling load() restarts ONE load, as in a browser:
  // one `error` event per load attempt, not one per call.
  private fail() {
    if (!this.failing || this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      this.emit("error");
    });
  }
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

async function drain(t: { mock: typeof mock }) {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(60_000);
  }
}

function hooksFor(policy: unknown, probeStatus: number) {
  const failures: string[] = [];
  const probes: string[] = [];
  let n = 0;
  return {
    failures,
    probes,
    hooks: {
      src: "/api/media/playlist/v1",
      refreshSrc: async () => `/api/media/playlist/v1?r=${++n}`,
      onSource: () => undefined,
      onFail: (m: string) => void failures.push(m),
      resumeAt: { current: 0 },
      policy: policy as never,
      probe: async (url: string) => {
        probes.push(url);
        return probeStatus;
      },
    },
  };
}

test("native player, signed out: one probe, the sign-in message, and no reload loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { attachNative, createPlaybackRecovery, PLAYBACK_FAILURE_MESSAGES } = await recovery();
  const video = new FakeVideo();
  const h = hooksFor(createPlaybackRecovery(), 401);
  const detach = attachNative(video, h.hooks);
  await drain(t);
  detach();
  assert.ok(video.srcSets + video.loads <= 2, `the element was reloaded ${video.srcSets + video.loads} times`);
  assert.deepEqual(h.failures, [PLAYBACK_FAILURE_MESSAGES.signed_out]);
  assert.match(PLAYBACK_FAILURE_MESSAGES.signed_out, /sign in/i);
});

test("native player, Storage down (playlist fine, media failing): a few spaced re-signs, then a message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { attachNative, createPlaybackRecovery, PLAYBACK_FAILURE_MESSAGES } = await recovery();
  const video = new FakeVideo();
  const h = hooksFor(createPlaybackRecovery(), 200);
  const detach = attachNative(video, h.hooks);
  await drain(t);
  detach();
  assert.ok(video.srcSets <= 4, `re-signed ${video.srcSets - 1} times`);
  assert.deepEqual(h.failures, [PLAYBACK_FAILURE_MESSAGES.generic]);
});

class FakeHls {
  static made: FakeHls[] = [];
  handlers: Array<(e: unknown, data: unknown) => void> = [];
  destroyed = false;
  constructor(private readonly data: unknown) {
    FakeHls.made.push(this);
  }
  loadSource() {
    setImmediate(() => {
      if (!this.destroyed) for (const fn of this.handlers) fn("hlsError", this.data);
    });
  }
  attachMedia() {}
  on(_event: string, fn: (e: unknown, data: unknown) => void) {
    this.handlers.push(fn);
  }
  recoverMediaError() {}
  destroy() {
    this.destroyed = true;
  }
}

/** The component's effect, as far as the error path goes: re-attach on each new source. */
async function runHls(t: { mock: typeof mock }, data: unknown) {
  const { attachHls, createPlaybackRecovery } = await recovery();
  FakeHls.made = [];
  const video = new FakeVideo();
  video.failing = false;
  const policy = createPlaybackRecovery();
  const failures: string[] = [];
  let detach: () => void = () => undefined;
  let n = 0;
  const attach = (src: string) => {
    detach();
    detach = attachHls(video, new FakeHls(data) as never, "hlsError", {
      src,
      refreshSrc: async () => `/api/media/playlist/v1?r=${++n}`,
      onSource: (next) => attach(next),
      onFail: (m) => void failures.push(m),
      resumeAt: { current: 0 },
      policy,
    });
  };
  attach("/api/media/playlist/v1");
  await drain(t);
  detach();
  return { instances: FakeHls.made.length, failures };
}

test("hls.js, signed out mid-video: the playlist's 401 ends it with the sign-in message, no rebuild loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PLAYBACK_FAILURE_MESSAGES } = await recovery();
  const r = await runHls(t, { fatal: true, type: "networkError", details: "manifestLoadError", response: { code: 401 } });
  assert.equal(r.instances, 1, `rebuilt ${r.instances - 1} times`);
  assert.deepEqual(r.failures, [PLAYBACK_FAILURE_MESSAGES.signed_out]);
});

test("hls.js, output missing (502): at most one re-sign, then 'not available'", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PLAYBACK_FAILURE_MESSAGES } = await recovery();
  const r = await runHls(t, { fatal: true, type: "networkError", details: "manifestLoadError", response: { code: 502 } });
  assert.ok(r.instances <= 2, `rebuilt ${r.instances - 1} times`);
  assert.deepEqual(r.failures, [PLAYBACK_FAILURE_MESSAGES.unavailable]);
});

test("HlsPlayer loads with this module and renders its video element", async () => {
  // The effect that calls attachNative / attachHls cannot run without a DOM;
  // tests/governance/test_video_player_recovery_wiring.test.mjs pins that call.
  const { renderSync, h } = await import("./_ui.js");
  const { HlsPlayer } = await import("../../apps/web/src/components/video/HlsPlayer.tsx");
  const html = renderSync(h(HlsPlayer, { src: "/api/media/playlist/v1", watermark: "Mentor · 2026-09-25 10:00 UTC" }));
  assert.match(html, /<video\b/);
});

test("hls.js, segments failing: bounded re-signs, then a message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PLAYBACK_FAILURE_MESSAGES } = await recovery();
  const r = await runHls(t, { fatal: true, type: "networkError", details: "fragLoadError", response: { code: 400 } });
  assert.ok(r.instances <= 4, `rebuilt ${r.instances - 1} times`);
  assert.deepEqual(r.failures, [PLAYBACK_FAILURE_MESSAGES.generic]);
});
