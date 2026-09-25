// The transcoder's OUTPUT, executed: the worker's real ffmpeg arguments
// (apps/worker/src/encode.ts) run through a real ffmpeg, and what comes out
// probed with ffprobe.
//
// Why this is its own tier of evidence: a regex over the argument list says
// nothing about what an encoder does with a given source. `scale=-2:480` reads
// as "480p" and makes a 270-pixel-wide portrait video; a list with no pixel
// format reads as nothing at all and makes H.264 High 10 out of an iPhone clip.
// Only encoding a source and probing the result shows either.
//
// Needs ffmpeg and ffprobe on PATH, and SKIPS, saying so, without them. CI
// installs them for the behaviour job, and also runs this file inside the
// production worker image (.github/workflows/test.yml), because that image's
// Debian ffmpeg is the binary that actually ships.
//
// Imports nothing but node builtins and encode.ts, so it can run in that image.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hlsEncodeArgs,
  parseProbe,
  posterArgs,
  probeArgs,
  renditionProbeArgs,
  renditionProblem,
} from "../../apps/worker/src/encode.ts";

const tools = ["ffmpeg", "ffprobe"].every((bin) => spawnSync(bin, ["-version"]).status === 0);
// CI sets GML_REQUIRE_FFMPEG=1 wherever it has installed ffmpeg, so a runner
// that lost it fails here instead of skipping its way to green.
if (!tools && process.env.GML_REQUIRE_FFMPEG === "1") {
  throw new Error("GML_REQUIRE_FFMPEG=1 but ffmpeg/ffprobe are not on PATH");
}
const skip = tools
  ? false
  : "ffmpeg/ffprobe not on PATH -- these tests run the worker's real encoder settings (CI installs ffmpeg)";

const dir = tools ? mkdtempSync(join(tmpdir(), "gml-encode-test-")) : "";
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")}\nexited ${r.status}: ${r.stderr.slice(-3000)}`);
  return r.stdout;
}

const hasEncoder = (name: string) =>
  tools && run("ffmpeg", ["-hide_banner", "-encoders"]).split("\n").some((l) => l.includes(` ${name} `));

/** A one-second synthetic source: `size` WxH, the given pixel format / codec / tags. */
function source(name: string, opts: { size?: string; args: string[] }): string {
  const out = join(dir, name);
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${opts.size ?? "640x360"}:rate=25`,
    "-t", "1",
    ...opts.args,
    out,
  ]);
  return out;
}

type StreamInfo = {
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  color_transfer?: string;
};

function streamOf(path: string): StreamInfo {
  const out = run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,color_transfer",
    "-of", "json", path,
  ]);
  return (JSON.parse(out) as { streams: StreamInfo[] }).streams[0]!;
}

type Variant = { uri: string; bandwidth: number; resolution: string; codecs: string };

/** The variants a master playlist lists, in order. */
function variantsOf(master: string): Variant[] {
  const out: Variant[] = [];
  const lines = master.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const attr = (k: string) => new RegExp(`(?:^|,)${k}=("[^"]*"|[^,]*)`).exec(m[1]!)?.[1]?.replace(/"/g, "") ?? "";
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"))!;
    out.push({ uri, bandwidth: Number(attr("BANDWIDTH")), resolution: attr("RESOLUTION"), codecs: attr("CODECS") });
  }
  return out;
}

/** The first segment a media playlist names. */
const firstSegment = (outDir: string, playlist: string) =>
  join(outDir, readFileSync(join(outDir, playlist), "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"))!);

/**
 * Probe the source and encode it exactly as the worker does. Returns the TOP
 * rendition's first segment (the one the 480p settings produce), and every
 * rendition when the output is a ladder under a master playlist.
 */
function transcode(src: string): {
  outDir: string;
  seg: string;
  stream: StreamInfo;
  master: string | null;
  variants: Array<Variant & { stream: StreamInfo }>;
} {
  const outDir = join(dir, `${src.split(/[\\/]/).pop()}-out`);
  mkdirSync(outDir, { recursive: true });
  const probe = parseProbe(run("ffprobe", probeArgs(src)));
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...hlsEncodeArgs(src, outDir, probe)]);
  const masterPath = join(outDir, "master.m3u8");
  if (!existsSync(masterPath)) {
    const seg = join(outDir, "seg_00000.ts");
    return { outDir, seg, stream: streamOf(seg), master: null, variants: [] };
  }
  const master = readFileSync(masterPath, "utf8");
  const variants = variantsOf(master).map((v) => ({ ...v, stream: streamOf(firstSegment(outDir, v.uri)) }));
  const top = variants[variants.length - 1]!;
  return { outDir, seg: firstSegment(outDir, top.uri), stream: top.stream, master, variants };
}

// ── F02: every source comes out as H.264 a phone can decode ─────────────────
//
// libx264 is built for 8- AND 10-bit in both the static ffmpeg of the local
// image and Debian's package, so with no pixel format given it keeps the
// source's: an iPhone HDR clip became H.264 High 10, which Safari/iOS, Firefox
// and 32-bit-ARM Android cannot decode, and was marked 'ready' regardless.

// The colour tags are set on the FRAMES (setparams), not with -color_trc: since
// ffmpeg 7 an encoder takes its colour properties from the frames, so an
// option alone produces an untagged file -- an "HDR" source that never
// exercises the HDR path. Each tagged source below is checked to really carry
// its transfer before its output is judged.
const hdrTags = (trc: string) => ["-vf", `setparams=color_primaries=bt2020:color_trc=${trc}:colorspace=bt2020nc`];

const PHONE_SOURCES: Array<{ name: string; file: string; args: string[]; needs?: string; hdr?: string }> = [
  { name: "8-bit 4:2:0 (the control: must be unchanged)", file: "sdr8.mp4", args: ["-pix_fmt", "yuv420p", "-c:v", "libx264"] },
  { name: "10-bit H.264 (Android HDR)", file: "h264-10.mp4", args: ["-pix_fmt", "yuv420p10le", "-c:v", "libx264"] },
  {
    name: "10-bit PQ H.264 (HDR10)",
    file: "pq10.mp4",
    hdr: "smpte2084",
    args: [...hdrTags("smpte2084"), "-pix_fmt", "yuv420p10le", "-c:v", "libx264"],
  },
  {
    name: "10-bit HLG HEVC (iPhone HDR)",
    file: "hlg10.mp4",
    hdr: "arib-std-b67",
    needs: "libx265",
    args: [
      ...hdrTags("arib-std-b67"),
      "-pix_fmt", "yuv420p10le", "-c:v", "libx265", "-x265-params", "log-level=error", "-tag:v", "hvc1",
    ],
  },
  { name: "4:4:4 H.264 (screen capture)", file: "h264-444.mp4", args: ["-pix_fmt", "yuv444p", "-c:v", "libx264"] },
  { name: "4:2:2 MJPEG AVI (ALLOWED_VIDEO_TYPES admits video/x-msvideo)", file: "mjpeg422.avi", args: ["-pix_fmt", "yuvj422p", "-c:v", "mjpeg"] },
];

for (const s of PHONE_SOURCES) {
  test(`F02: ${s.name} is transcoded to 8-bit 4:2:0 H.264 High`, { skip: skip || (s.needs && !hasEncoder(s.needs) ? `${s.needs} not available` : false) }, () => {
    const src = source(s.file, { args: s.args });
    if (s.hdr) assert.equal(streamOf(src).color_transfer, s.hdr, "the synthetic source is not tagged HDR");
    const out = transcode(src);
    // Every rendition a player might pick, not just the top one.
    for (const stream of out.variants.length > 0 ? out.variants.map((v) => v.stream) : [out.stream]) {
      assert.equal(stream.codec_name, "h264");
      assert.equal(stream.pix_fmt, "yuv420p", `pixel format ${stream.pix_fmt} is not what phones decode`);
      assert.equal(stream.profile, "High", `profile ${stream.profile} has no hardware decoder and no Safari/iOS support`);
      if (s.hdr) {
        assert.ok(
          stream.color_transfer !== "smpte2084" && stream.color_transfer !== "arib-std-b67",
          `an HDR transfer (${stream.color_transfer}) was passed through untouched into an 8-bit SDR stream`,
        );
      }
    }
  });
}

test("F02: a rendition that is not 8-bit 4:2:0 H.264 is refused before it can be marked ready", { skip }, () => {
  // What the worker produced before: a 10-bit stream in the segment container.
  const bad = join(dir, "high10.ts");
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source("bad-src.mp4", { args: ["-pix_fmt", "yuv420p10le", "-c:v", "libx264"] }), "-c", "copy", "-f", "mpegts", bad]);
  const good = transcode(source("good-src.mp4", { args: ["-pix_fmt", "yuv420p", "-c:v", "libx264"] })).seg;

  assert.match(renditionProblem(run("ffprobe", renditionProbeArgs(bad))) ?? "", /High 10|yuv420p10le/);
  assert.equal(renditionProblem(run("ffprobe", renditionProbeArgs(good))), null);
});

// ── F10: the SHORT side is capped at 480, and nothing is scaled up ──────────
//
// `scale=-2:480` pinned the HEIGHT: a phone held upright (1080x1920, or a
// landscape-coded clip with a 90-degree rotation, which ffmpeg autorotates
// before the filter) came out 270 px wide -- too narrow to read a blackboard
// -- and a 320x180 WhatsApp forward was scaled UP to 854x480, spending about
// twice the bytes on interpolated pixels in a pipeline built for 2G.

const SIZES: Array<{ name: string; size: string; expect: [number, number]; args?: string[] }> = [
  { name: "portrait phone 1080x1920", size: "1080x1920", expect: [480, 854] },
  { name: "landscape 1920x1080 (unchanged)", size: "1920x1080", expect: [854, 480] },
  { name: "small 320x180 forward (not upscaled)", size: "320x180", expect: [320, 180] },
  { name: "small portrait 360x640 (not upscaled)", size: "360x640", expect: [360, 640] },
  { name: "square 480x480", size: "480x480", expect: [480, 480] },
  // Odd sizes need 4:4:4 to be encoded at all; the output must still be even.
  { name: "odd 321x181", size: "321x181", expect: [320, 180], args: ["-pix_fmt", "yuv444p", "-c:v", "libx264"] },
];

for (const s of SIZES) {
  test(`F10: ${s.name} comes out ${s.expect.join("x")}`, { skip }, () => {
    const src = source(`size-${s.size}.mp4`, { size: s.size, args: s.args ?? ["-pix_fmt", "yuv420p", "-c:v", "libx264"] });
    const { stream } = transcode(src);
    assert.deepEqual([stream.width, stream.height], s.expect);
  });
}

test("F10: a phone clip coded landscape with a 90-degree rotation comes out portrait, 480 wide", { skip }, () => {
  const coded = source("rotated-coded.mp4", { size: "1920x1080", args: ["-pix_fmt", "yuv420p", "-c:v", "libx264"] });
  const rotated = join(dir, "rotated.mp4");
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", coded, "-c", "copy", rotated]);
  const { stream } = transcode(rotated);
  assert.deepEqual([stream.width, stream.height], [480, 854]);
});

test("F10: the poster frame follows the same rule at 360", { skip }, () => {
  for (const [size, expect] of [["1080x1920", [360, 640]], ["320x180", [320, 180]]] as const) {
    const src = source(`poster-${size}.mp4`, { size, args: ["-pix_fmt", "yuv420p", "-c:v", "libx264"] });
    const jpg = join(dir, `poster-${size}.jpg`);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...posterArgs(src, jpg, 0)]);
    const st = streamOf(jpg);
    assert.deepEqual([st.width, st.height], expect, `poster of a ${size} source`);
  }
});

// ── F144: an adaptive ladder, with a rung a 2G link can carry ───────────────
//
// The output was ONE ~800 kbps 480p media playlist. On a link below that the
// player stalls continuously and hls.js has nothing to switch down to --
// while the help panel told mentors it drops to 240p on a weak network.

const withSound = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-shortest", "-c:a", "aac"];

test("F144: a 720p source is encoded as a 240p / 360p / 480p ladder under a master playlist", { skip }, () => {
  const out = transcode(source("ladder-720.mp4", { size: "1280x720", args: [...withSound, "-pix_fmt", "yuv420p", "-c:v", "libx264"] }));
  assert.ok(out.master, "no master playlist -- a single rendition leaves the player nothing to switch down to");
  assert.deepEqual(out.variants.map((v) => v.resolution), ["426x240", "640x360", "854x480"]);
  for (const v of out.variants) {
    const [w, hgt] = v.resolution.split("x").map(Number);
    assert.deepEqual([v.stream.width, v.stream.height], [w, hgt], `${v.uri} is not the size its master entry declares`);
    assert.match(v.codecs, /mp4a/, `${v.uri} has no audio -- a lesson video without its sound`);
  }
  // Declared peak bandwidth, lowest first. The bottom rung is the one a 2G
  // link has to carry: ~200 kbps video plus 48 kbps audio.
  const bw = out.variants.map((v) => v.bandwidth);
  assert.deepEqual([...bw].sort((a, b) => a - b), bw, "variants must be listed lowest first");
  assert.ok(bw[0]! <= 300_000, `the lowest rung declares ${bw[0]} bit/s`);
});

test("F144: a portrait source's rungs are portrait", { skip }, () => {
  const out = transcode(source("ladder-portrait.mp4", { size: "1080x1920", args: ["-pix_fmt", "yuv420p", "-c:v", "libx264"] }));
  assert.deepEqual(out.variants.map((v) => v.resolution), ["240x426", "360x640", "480x854"]);
});

test("F144: a small source gets no upscaled rungs", { skip }, () => {
  const out = transcode(source("ladder-small.mp4", { size: "320x180", args: ["-pix_fmt", "yuv420p", "-c:v", "libx264"] }));
  assert.deepEqual(out.variants.map((v) => v.resolution), ["320x180"], "a rung above the source is an upscale in disguise");
});

// ── F15: a failure says what failed, first ──────────────────────────────────

test("F15: ffmpeg's failure output is the error itself, not its banner and progress", { skip }, () => {
  // Random bytes named .mp4: what a broken phone export or a truncated
  // WhatsApp forward looks like to ffmpeg.
  const garbage = join(dir, "garbage.mp4");
  writeFileSync(garbage, Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 251)));
  const outDir = join(dir, "garbage-out");
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync("ffmpeg", hlsEncodeArgs(garbage, outDir, { durationSec: null, width: null, height: null }), {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0, "ffmpeg accepted random bytes");
  // Callers keep a bounded slice of this, and the DLQ shows its first 60
  // characters: they used to be "ffmpeg version 7.1 Copyright (c) 20..." on
  // every failure, with the real reason ~1800 characters further in, or cut
  // off entirely behind progress lines.
  assert.doesNotMatch(r.stderr, /ffmpeg version|configuration:|built with/, "the banner is still printed");
  assert.match(r.stderr.slice(0, 300), /Invalid data|Error opening input|moov atom/i, `the error is not up front:\n${r.stderr.slice(0, 500)}`);
});

test("F144: a source without sound still gets its ladder", { skip }, () => {
  const out = transcode(source("ladder-silent.mp4", { size: "1280x720", args: ["-pix_fmt", "yuv420p", "-c:v", "libx264"] }));
  assert.equal(out.variants.length, 3);
  for (const v of out.variants) assert.doesNotMatch(v.codecs, /mp4a/);
});
