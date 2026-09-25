// What the HLS player does when playback dies.
//
// Used by components/video/HlsPlayer.tsx, whose effect calls attachNative or
// attachHls. Kept here, free of React and the DOM, so tests/behaviour can run
// it with a fake <video> and a fake hls.js (hls-playback-recovery.test.ts).
//
// THE LOOP THIS REPLACES. Every fatal non-media hls.js error, and every native
// `error` event, was treated as an expired segment URL and re-signed at once.
// On hls.js the new source rebuilt the Hls instance -- with fresh retry
// counters -- which failed the same way; on the native branch video.src was
// reassigned on every error. The one exit to an error message was a catch
// around refreshSrc, which cannot throw. So a condition a re-sign can never fix
// -- signed out, access revoked, output missing, Storage down -- was a black
// player and a request storm (12-26 playlist requests a second per tab on a
// 4xx, measured), with no message at all.
//
// THE POLICY. The playlist route's own answer decides where it can:
//   401          signed out            fail at once
//   403 / 404    no longer allowed     fail at once (403 is the section gate)
//   409 / 502    output not playable   one re-sign, then fail
// Anything else (an expired signed segment URL is a 400 from Storage, a 5xx,
// no response) is re-signed with backoff, a bounded number of times, then
// fails. Real playback past the point of failure restores the budget, so a
// long lesson can outlive several segment-URL lifetimes.

export type FailReason = "signed_out" | "no_access" | "unavailable" | "generic";
export type PlaybackFailure = {
  /** HTTP status of the failed request, when the player knows it. */
  status?: number;
  /** The playlist (the app's route) or a segment (Storage). */
  source: "playlist" | "segment";
  /** Playback position when it failed, in seconds. */
  at: number;
};
export type RecoveryAction = { kind: "refresh"; delayMs: number } | { kind: "fail"; reason: FailReason };
export type PlaybackRecovery = { onFatal(f: PlaybackFailure): RecoveryAction; onProgress(at: number): void };

export const PLAYBACK_FAILURE_MESSAGES: Record<FailReason, string> = {
  signed_out: "Your session has ended. Sign in again to keep watching.",
  no_access: "You no longer have access to this video. Reload the page to check.",
  unavailable: "This video is not available right now. Tell your programme admin.",
  generic: "Playback failed. Check your connection and reload the page.",
};

export function createPlaybackRecovery({ maxRefreshes = 2, baseDelayMs = 2_000 } = {}): PlaybackRecovery {
  let used = 0;
  let failedAt = -Infinity;
  const refresh = (): RecoveryAction => ({ kind: "refresh", delayMs: baseDelayMs * 2 ** used++ });
  return {
    onFatal({ status, source, at }) {
      failedAt = Math.max(failedAt, at);
      if (source === "playlist") {
        if (status === 401) return { kind: "fail", reason: "signed_out" };
        if (status === 403 || status === 404) return { kind: "fail", reason: "no_access" };
        if (status === 409 || status === 502) return used >= 1 ? { kind: "fail", reason: "unavailable" } : refresh();
      }
      return used >= maxRefreshes ? { kind: "fail", reason: "generic" } : refresh();
    },
    onProgress(at) {
      // Past the point that failed, by more than a moment: a re-signed source
      // that loads and stalls at the same spot is the same failure.
      if (used > 0 && at > failedAt + 1) used = 0;
    },
  };
}

export type ResumeRef = { current: number };

export type PlaybackHooks = {
  src: string;
  refreshSrc: () => Promise<string>;
  /** hls.js path: load this source (the component re-runs its effect). */
  onSource: (next: string) => void;
  /** Show this message over the player. */
  onFail: (message: string) => void;
  resumeAt: ResumeRef;
  /** Shared across re-attachments, so the budget survives a source change. */
  policy: PlaybackRecovery;
  /** HTTP status of a GET of the playlist URL (the native element exposes none). */
  probe?: (url: string) => Promise<number>;
};

type VideoLike = {
  currentTime: number;
  src: string;
  load(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

const probePlaylist = async (url: string): Promise<number> =>
  (await fetch(url, { cache: "no-store", credentials: "same-origin" })).status;

const isOk = (status: number) => status >= 200 && status < 300;

/** Safari, iOS -- and desktop Chrome, which answers canPlayType("...mpegurl") with "maybe". */
export function attachNative(video: VideoLike, hooks: PlaybackHooks): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const onProgress = () => hooks.policy.onProgress(video.currentTime);
  const onNativeError = async () => {
    if (done || timer) return;
    const at = video.currentTime;
    hooks.resumeAt.current = at || hooks.resumeAt.current;
    let next: string;
    try {
      next = await hooks.refreshSrc();
    } catch {
      next = "";
    }
    // The element says only that it failed. Ask the playlist route what it
    // answers now: a 401/403/404/502 there is the reason, and a 200 means the
    // failure was a segment (an expired URL, or Storage).
    const status = next ? await (hooks.probe ?? probePlaylist)(next).catch(() => 0) : 0;
    if (done) return;
    const action = hooks.policy.onFatal(isOk(status) ? { source: "segment", at } : { status, source: "playlist", at });
    if (action.kind === "fail") {
      // And stop: no further source is assigned, so nothing retries behind
      // the message.
      done = true;
      hooks.onFail(PLAYBACK_FAILURE_MESSAGES[action.reason]);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (done) return;
      video.src = next;
      video.load();
    }, action.delayMs);
  };
  video.addEventListener("error", onNativeError);
  video.addEventListener("timeupdate", onProgress);
  video.src = hooks.src;
  return () => {
    done = true;
    if (timer) clearTimeout(timer);
    video.removeEventListener("error", onNativeError);
    video.removeEventListener("timeupdate", onProgress);
  };
}

export type HlsErrorData = { fatal: boolean; type: string; details?: string; response?: { code?: number } };
export type HlsLike = {
  loadSource(src: string): void;
  attachMedia(video: unknown): void;
  on(event: string, fn: (e: unknown, data: HlsErrorData) => void): void;
  recoverMediaError(): void;
  destroy(): void;
  currentLevel?: number;
};

export function attachHls(video: VideoLike, hls: HlsLike, errorEvent: string, hooks: PlaybackHooks): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const onProgress = () => hooks.policy.onProgress(video.currentTime);
  hls.loadSource(hooks.src);
  hls.attachMedia(video);
  hls.on(errorEvent, (_e, data) => {
    if (!data.fatal || done || timer) return;
    // A media error is recoverable in place and must NOT cost a re-sign
    // round trip -- hls.js can rebuild its buffer itself.
    if (data.type === "mediaError") {
      hls.recoverMediaError();
      return;
    }
    const at = video.currentTime;
    // Fragment (and key) loads go to Storage; everything else here is the
    // playlist route, whose status is the reason.
    const source = /^(frag|key)/i.test(data.details ?? "") ? "segment" : "playlist";
    const action = hooks.policy.onFatal({ status: data.response?.code, source, at });
    if (action.kind === "fail") {
      done = true;
      hls.destroy();
      hooks.onFail(PLAYBACK_FAILURE_MESSAGES[action.reason]);
      return;
    }
    hooks.resumeAt.current = at || hooks.resumeAt.current;
    timer = setTimeout(async () => {
      timer = undefined;
      if (done) return;
      try {
        hooks.onSource(await hooks.refreshSrc());
      } catch {
        done = true;
        hooks.onFail(PLAYBACK_FAILURE_MESSAGES.generic);
      }
    }, action.delayMs);
  });
  video.addEventListener("timeupdate", onProgress);
  return () => {
    done = true;
    if (timer) clearTimeout(timer);
    video.removeEventListener("timeupdate", onProgress);
    hls.destroy();
  };
}
