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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hlsEncodeArgs, parseProbe, probeArgs } from "../../apps/worker/src/encode.ts";
import * as encode from "../../apps/worker/src/encode.ts";

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

/** Probe the source and encode it exactly as the worker does; return the first segment's stream. */
function transcode(src: string): { seg: string; stream: StreamInfo } {
  const outDir = join(dir, `${src.split(/[\\/]/).pop()}-out`);
  mkdirSync(outDir, { recursive: true });
  const probe = parseProbe(run("ffprobe", probeArgs(src)));
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...hlsEncodeArgs(src, outDir, probe)]);
  const seg = join(outDir, "seg_00000.ts");
  return { seg, stream: streamOf(seg) };
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
    const { stream } = transcode(src);
    assert.equal(stream.codec_name, "h264");
    assert.equal(stream.pix_fmt, "yuv420p", `pixel format ${stream.pix_fmt} is not what phones decode`);
    assert.equal(stream.profile, "High", `profile ${stream.profile} has no hardware decoder and no Safari/iOS support`);
    if (s.hdr) {
      assert.ok(
        stream.color_transfer !== "smpte2084" && stream.color_transfer !== "arib-std-b67",
        `an HDR transfer (${stream.color_transfer}) was passed through untouched into an 8-bit SDR stream`,
      );
    }
  });
}

test("F02: a rendition that is not 8-bit 4:2:0 H.264 is refused before it can be marked ready", { skip }, () => {
  // What the worker produced before: a 10-bit stream in the segment container.
  const bad = join(dir, "high10.ts");
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source("bad-src.mp4", { args: ["-pix_fmt", "yuv420p10le", "-c:v", "libx264"] }), "-c", "copy", "-f", "mpegts", bad]);
  const good = transcode(source("good-src.mp4", { args: ["-pix_fmt", "yuv420p", "-c:v", "libx264"] })).seg;

  const problem = (encode as Record<string, unknown>).renditionProblem as ((stdout: string) => string | null) | undefined;
  assert.equal(typeof problem, "function", "encode.ts has no check of what the encoder produced");
  const probeRendition = (encode as Record<string, unknown>).renditionProbeArgs as (p: string) => string[];
  assert.match(problem!(run("ffprobe", probeRendition(bad))) ?? "", /High 10|yuv420p10le/);
  assert.equal(problem!(run("ffprobe", probeRendition(good))), null);
});
