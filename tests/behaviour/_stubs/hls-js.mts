// Stands in for hls.js when tests/behaviour/hls-source-selection.test.ts
// mounts the real HlsPlayer. hls.js is a browser boundary like the <video>
// element: Hls.isSupported() asks the browser for Media Source Extensions,
// which Node does not have, and an attached instance drives a real
// MediaSource. What the player decides FROM that answer -- which engine it
// hands the element to -- is the behaviour under test, so the answer is the
// test's to set (`__gmlFakeHls.supported`) and each instance records what the
// player asked of it.

type Handler = (event: unknown, data: unknown) => void;

export type FakeHlsState = { supported: boolean; made: FakeHls[] };

export const fakeHls = (): FakeHlsState =>
  ((globalThis as Record<string, unknown>).__gmlFakeHls ??= { supported: true, made: [] }) as FakeHlsState;

export default class FakeHls {
  static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" } as const;
  static isSupported(): boolean {
    return fakeHls().supported;
  }

  readonly sources: string[] = [];
  media: unknown = null;
  destroyed = false;
  levels: Array<{ width: number; height: number }> = [];
  currentLevel = -1;
  private readonly handlers = new Map<string, Handler[]>();
  readonly config: unknown;

  // No parameter property: the player's import() of this file is loaded by
  // Node's type stripping, which refuses TypeScript syntax that emits code.
  constructor(config: unknown) {
    this.config = config;
    fakeHls().made.push(this);
  }
  loadSource(src: string): void {
    this.sources.push(src);
  }
  attachMedia(media: unknown): void {
    this.media = media;
  }
  on(event: string, fn: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  /** Fire `event` at the player's handlers, as hls.js would. */
  emit(event: string, data: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(event, data);
  }
  recoverMediaError(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}
