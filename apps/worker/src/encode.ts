// ffmpeg / ffprobe arguments for the HLS transcode, and the parsing of what
// ffprobe says, as PURE functions.
//
// They live apart from transcode.ts for one reason: so they can be executed.
// transcode.ts needs a database and Supabase Storage before it ever reaches
// ffmpeg, which kept its encoder settings out of reach of every test -- and
// the settings are exactly where the defects were. With nothing but node:path
// imported here, a test can run these arguments through a real ffmpeg and probe what comes out
// (tests/behaviour/transcode-output.test.ts), and CI can do the same inside
// the production worker image, whose Debian ffmpeg is the one that ships.

import { join } from "node:path";

/** What ffprobe tells us about the source. All fields optional: a probe that
 *  fails must not fail the transcode, it just costs us the metadata. */
export type Probe = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** The source's colour tags, when it carries them -- they decide tone-mapping. */
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
  colorSpace?: string | null;
};

/** ffprobe arguments for the source's duration and first video stream. */
export function probeArgs(path: string): string[] {
  return [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,color_transfer,color_primaries,color_space",
    "-show_entries", "format=duration",
    "-of", "json",
    path,
  ];
}

/** Parse probeArgs() output. Throws on unparseable JSON; the caller decides. */
export function parseProbe(stdout: string): Probe {
  const parsed = JSON.parse(stdout) as {
    streams?: {
      width?: number;
      height?: number;
      color_transfer?: string;
      color_primaries?: string;
      color_space?: string;
    }[];
    format?: { duration?: string };
  };
  const s0 = parsed.streams?.[0];
  const d = parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : NaN;
  return {
    durationSec: Number.isFinite(d) && d > 0 ? Math.round(d) : null,
    width: s0?.width ?? null,
    height: s0?.height ?? null,
    colorTransfer: s0?.color_transfer ?? null,
    colorPrimaries: s0?.color_primaries ?? null,
    colorSpace: s0?.color_space ?? null,
  };
}

/** PQ (HDR10, Dolby Vision 8.1) and HLG (iPhone HDR, Dolby Vision 8.4's base layer). */
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

/**
 * HDR to SDR, before scaling. ONLY for a source the probe says is HDR.
 *
 * Applied unconditionally this chain makes ffmpeg exit 187 ("Nothing was
 * written into output file") on an untagged SDR source -- every ordinary
 * upload -- because zscale cannot linearise a transfer it was not told. The
 * input tags are stated explicitly for the same reason: an HDR clip whose
 * primaries or matrix are missing would otherwise fail the same way. The float
 * step is what the tonemap filter needs to work on.
 */
function toneMapFilters(probe: Probe): string[] {
  if (!probe.colorTransfer || !HDR_TRANSFERS.has(probe.colorTransfer)) return [];
  return [
    `zscale=tin=${probe.colorTransfer}:pin=${probe.colorPrimaries || "bt2020"}` +
      `:min=${probe.colorSpace || "bt2020nc"}:t=linear:npl=100`,
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
  ];
}

/**
 * The HLS encode: one 480p media playlist plus its segments in `outDir`.
 *
 * Targets ~800 kbps total (480p video + 64 kbps mono AAC) for Ladakh 3G.
 *
 * ALWAYS 8-bit 4:2:0, High profile. libx264 is built for 8- and 10-bit in both
 * the static ffmpeg and Debian's package, and with no pixel format it keeps
 * the source's: a 10-bit phone clip (iPhone HDR, Android 10-bit) came out as
 * H.264 High 10, a screen capture as High 4:4:4, an MJPEG AVI as High 4:2:2.
 * None has a hardware decoder anywhere, and Safari/iOS, Firefox and 32-bit-ARM
 * Android cannot play them at all -- yet each was marked 'ready'. For an
 * ordinary 8-bit 4:2:0 source both settings change nothing. `-profile:v high`
 * also makes any future non-8-bit leak a loud encoder error rather than a
 * quietly unplayable stream. No `-level`: a high-frame-rate phone source at
 * 480p exceeds Level 3.1, and the stream would declare a level it breaks.
 */
export function hlsEncodeArgs(input: string, outDir: string, probe: Probe): string[] {
  const toneMap = toneMapFilters(probe);
  return [
    "-y",
    "-i", input,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "veryfast",
    "-crf", "26",
    "-maxrate", "800k",
    "-bufsize", "1600k",
    // scale=-2:480 keeps the aspect ratio and forces an EVEN width, which
    // libx264 requires; a bare -1 produces odd widths on some sources and
    // ffmpeg then refuses the encode. out_range=tv brings full-range sources
    // (MJPEG, some Android cameras) to the limited range web delivery expects;
    // it changes nothing on a source that is already limited. format= comes
    // last so the conversion does not depend on option order.
    "-vf", [...toneMap, "scale=-2:480:out_range=tv", "format=yuv420p"].join(","),
    // A tone-mapped stream is BT.709 now and must say so; leaving the BT.2020
    // / PQ / HLG tags on it would make a player "correct" it a second time.
    ...(toneMap.length > 0
      ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
      : []),
    "-c:a", "aac",
    "-b:a", "64k",
    "-ac", "1",
    // Segment boundaries must be keyframe-aligned or players stall at each
    // join. At 6s segments and 25fps that is a keyframe every 150 frames.
    "-g", "150",
    "-keyint_min", "150",
    "-sc_threshold", "0",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", join(outDir, "seg_%05d.ts"),
    join(outDir, "index.m3u8"),
  ];
}

/** ffprobe arguments for what the encoder actually wrote into a segment. */
export function renditionProbeArgs(segmentPath: string): string[] {
  return [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,profile,pix_fmt",
    "-of", "json",
    segmentPath,
  ];
}

/** H.264 profiles every browser and phone decoder handles at 8-bit 4:2:0. */
const PLAYABLE_PROFILES = new Set(["High", "Main", "Constrained Baseline", "Baseline"]);

/**
 * Why a rendition is not universally playable, or null when it is.
 *
 * Checked BEFORE the upload and the 'ready' write. ffmpeg exiting 0 used to be
 * taken as proof of a playable video, and it is not: it proves only that ffmpeg
 * wrote something. An undecodable stream then reached 'ready', the teacher was
 * told it was done, and the reviewer got a player that never plays.
 */
export function renditionProblem(stdout: string): string | null {
  let s: { codec_name?: string; profile?: string; pix_fmt?: string } | undefined;
  try {
    s = (JSON.parse(stdout) as { streams?: (typeof s)[] }).streams?.[0];
  } catch {
    return "the encoded output could not be probed";
  }
  if (!s) return "the encoded output has no video stream";
  // yuvj420p is the same 8-bit 4:2:0 with a full-range flag: it decodes
  // everywhere, so it is not refused even though the encode normalises it.
  const eightBit420 = s.pix_fmt === "yuv420p" || s.pix_fmt === "yuvj420p";
  if (s.codec_name !== "h264" || !eightBit420 || !PLAYABLE_PROFILES.has(s.profile ?? "")) {
    return `the encoded output is ${s.codec_name ?? "?"} ${s.profile ?? "?"} ${s.pix_fmt ?? "?"}, ` +
      "not 8-bit 4:2:0 H.264 that every player can decode";
  }
  return null;
}

/** One poster frame, `atSec` into the source. */
export function posterArgs(input: string, output: string, atSec: number): string[] {
  return [
    "-y",
    "-ss", atSec.toFixed(2),
    "-i", input,
    "-frames:v", "1",
    "-vf", "scale=-2:360",
    "-q:v", "6",
    output,
  ];
}
