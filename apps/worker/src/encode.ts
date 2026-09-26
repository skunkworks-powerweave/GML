// ffmpeg / ffprobe arguments for the HLS transcode, and the parsing of what
// ffprobe says, as PURE functions.
//
// They live apart from transcode.ts for one reason: so they can be executed.
// transcode.ts needs a database and Supabase Storage before it ever reaches
// ffmpeg, which kept its encoder settings out of reach of every test -- and
// the settings are exactly where the defects were. With nothing but node:path
// imported here, a test can run these arguments through a real ffmpeg and
// probe what comes out (tests/behaviour/transcode-output.test.ts), and CI can
// do the same inside the production worker image, whose Debian ffmpeg is the
// one that ships.

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
  /**
   * Whether it has sound. Unknown (a failed probe) is treated as yes: the
   * audio is mapped explicitly, so a SILENT source then fails the encode on
   * that map (missingAudioMap), and the worker encodes it again without.
   */
  hasAudio?: boolean | null;
  /** Whether it has a picture at all. False only when the probe WORKED and found none. */
  hasVideo?: boolean | null;
};

/**
 * The first line of a failed ffmpeg/ffprobe run's error: which binary, its
 * exit code, and its LAST line of output -- the verdict -- followed by the
 * output itself. The DLQ shows the first 60 characters of an attempt's error,
 * and they used to read "Error: ffmpeg exited 183 ffmpeg version 7.1 Copyright
 * (c) 20..." for every failure alike.
 */
export function commandFailure(bin: string, code: number | null, stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  return `${bin} exited ${code}: ${lines[lines.length - 1] ?? "(no output)"}\n${stderr}`;
}

/** The same, for a run killed at its deadline: the verdict first, then what the tool had said. */
export function commandTimedOut(bin: string, deadlineMs: number, stderr: string): string {
  const s = Math.round(deadlineMs / 1000);
  return `${bin} did not finish within ${s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`}, so it was killed\n${stderr}`;
}

/**
 * How long one ffprobe run, or the poster's ffmpeg, may take before it is
 * killed. Each reads a local file and takes seconds; one still going after two
 * minutes is stuck (a demuxer looping on a malformed upload), not slow.
 */
export const PROBE_DEADLINE_MS = 2 * 60_000;

/**
 * How long the HLS encode may take before it is killed: six times the source's
 * duration, never under 30 minutes, and 4 hours when the probe could not say
 * how long the source is.
 *
 * A deadline, because nothing else ends a hung encode: runJob heartbeats the
 * lease for as long as the child runs, so the reaper never takes the job back,
 * and one stuck ffmpeg held the only transcode slot until someone restarted
 * the worker. Generous, because killing a real encode costs it an attempt: the
 * ladder runs at about three times real time for a 1080p source on the 2-vCPU
 * target, and slower while the web tier it yields to is busy.
 */
export function encodeDeadlineMs(durationSec: number | null | undefined): number {
  if (!durationSec || durationSec <= 0) return 4 * 60 * 60_000;
  return Math.max(30 * 60_000, 6 * durationSec * 1000);
}

/**
 * ffprobe's reason, when a failed probe means the SOURCE cannot be opened as
 * media at all -- which no retry changes -- or null for anything else (a
 * missing binary, a crash), which a retry might. The bytes were downloaded
 * whole: a truncated transfer fails the download, not the probe.
 */
export function unreadableSource(probeError: string): string | null {
  const m = /(Invalid data found when processing input|moov atom not found|could not find codec parameters|Error opening input[^\n]*)/i.exec(
    probeError,
  );
  return m ? m[1]! : null;
}

/** ffprobe arguments for the source's duration, its streams' kinds, and its video stream. */
export function probeArgs(path: string): string[] {
  return [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,color_transfer,color_primaries,color_space",
    "-show_entries", "format=duration",
    "-of", "json",
    path,
  ];
}

/** Parse probeArgs() output. Throws on unparseable JSON; the caller decides. */
export function parseProbe(stdout: string): Probe {
  const parsed = JSON.parse(stdout) as {
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      color_transfer?: string;
      color_primaries?: string;
      color_space?: string;
    }[];
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const d = parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : NaN;
  return {
    durationSec: Number.isFinite(d) && d > 0 ? Math.round(d) : null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    colorTransfer: v?.color_transfer ?? null,
    colorPrimaries: v?.color_primaries ?? null,
    colorSpace: v?.color_space ?? null,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: v !== undefined,
  };
}

/**
 * Errors only, no banner, no per-frame progress. What ffmpeg writes on failure
 * is kept (as the tail of its stderr) and shown; with the ~1800-character
 * version banner and a progress line per frame in front of it, the reason was
 * buried, or cut off entirely, on every failure.
 */
const QUIET = ["-hide_banner", "-nostats", "-loglevel", "error"];

/**
 * The rendition ladder, lowest first. Each rung caps its SHORT side (so a
 * portrait video's rungs are portrait) and its bitrate; the top rung is the
 * 480p settings the single rendition always had, unchanged.
 *
 * It was one ~800 kbps 480p rendition and nothing else. On a 2G or weak-3G
 * link below that the player stalls continuously and hls.js has no lower
 * rendition to switch to -- while the help panel told mentors it would drop
 * to 240p. The bottom rung is ~250 kbps all in. 480p stays the ceiling (SM-4).
 */
export const LADDER = [
  { name: "240p", short: 240, maxrate: "200k", bufsize: "400k", audio: "48k" },
  { name: "360p", short: 360, maxrate: "400k", bufsize: "800k", audio: "48k" },
  { name: "480p", short: 480, maxrate: "800k", bufsize: "1600k", audio: "64k" },
] as const;

export type Rung = (typeof LADDER)[number];

/** The master playlist's file name; its variants are v0.m3u8, v1.m3u8, ... beside it. */
export const MASTER_PLAYLIST = "master.m3u8";

/** Rendition `i`'s media playlist and first segment, as the encode below names them. */
export const variantPlaylist = (i: number) => `v${i}.m3u8`;
export const variantFirstSegment = (i: number) => `v${i}_00000.ts`;

/**
 * The rungs a source gets: none taller than the source itself -- a rung above
 * it would be an upscale in disguise, the bytes-for-nothing F10 removed -- and
 * always at least the lowest. The short side is the same whichever way a
 * rotated phone clip is coded, so the probe's coded size is enough.
 */
export function ladderFor(probe: Probe): Rung[] {
  if (!probe.width || !probe.height) return [...LADDER];
  const short = Math.min(probe.width, probe.height);
  const fit = LADDER.filter((r) => r.short <= short);
  return fit.length > 0 ? fit : [LADDER[0]];
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
 * A scale filter that caps the SHORTER side at `maxShort`, never scales up,
 * and keeps both sides even (libx264 refuses odd ones at 4:2:0).
 *
 * `scale=-2:480` pinned the height, whatever the orientation or size: a phone
 * held upright (1080x1920 -- or a landscape-coded clip with a rotation flag,
 * which ffmpeg autorotates BEFORE the filter) came out 270 px wide, too narrow
 * to read a blackboard, and a 320x180 WhatsApp forward was scaled UP to
 * 854x480 at about twice the bytes. Portrait 480x854 has the same pixel count
 * as landscape 854x480, which the bitrate caps were sized for.
 *
 * The quotes are filtergraph quoting; spawn() passes them through with no
 * shell. The scale filter treats a -2 that an expression EVALUATES to exactly
 * like a literal -2. That was run against the static ffmpeg 7.1
 * (tests/behaviour/transcode-output.test.ts); CI runs the same tests on
 * Ubuntu's packaged ffmpeg and inside the production image, on Debian's.
 */
export function boundedScale(maxShort: number): string {
  const w = `if(gte(iw,ih),-2,min(${maxShort},trunc(iw/2)*2))`;
  const h = `if(gte(iw,ih),min(${maxShort},trunc(ih/2)*2),-2)`;
  return `scale=w='${w}':h='${h}'`;
}

/**
 * The HLS encode: the ladder for this source (ladderFor) in ONE ffmpeg run, a
 * media playlist per rung (v0.m3u8 ...) and the master playlist listing them,
 * all flat in `outDir` beside their segments.
 *
 * One run, decoding the source once and splitting it, so every rung has its
 * keyframes on the same frames -- segment boundaries line up across rungs and
 * a player can switch between them at any segment.
 *
 * ALWAYS 8-bit 4:2:0, High profile. libx264 in the static ffmpeg 7.1 encodes
 * 8- and 10-bit (Debian packages x264 with both depths as well), and with no
 * pixel format it keeps the source's: a 10-bit phone clip (iPhone HDR, Android 10-bit) came out as
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
  const rungs = ladderFor(probe);
  const audio = probe.hasAudio !== false;
  // Tone-map once, split once per rung, then each rung: the short side capped
  // (see boundedScale); out_range=tv brings full-range sources (MJPEG, some
  // Android cameras) to the limited range web delivery expects and changes
  // nothing on one that is already limited; format= last, so the conversion
  // does not depend on option order.
  const graph = [
    `[0:v]${[...toneMap, `split=${rungs.length}`].join(",")}${rungs.map((_, i) => `[s${i}]`).join("")}`,
    ...rungs.map((r, i) => `[s${i}]${boundedScale(r.short)}:out_range=tv,format=yuv420p[v${i}]`),
  ].join(";");
  return [
    ...QUIET,
    "-y",
    "-i", input,
    "-filter_complex", graph,
    ...rungs.flatMap((_, i) => ["-map", `[v${i}]`, ...(audio ? ["-map", "0:a:0"] : [])]),
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "veryfast",
    "-crf", "26",
    ...rungs.flatMap((r, i) => [`-maxrate:v:${i}`, r.maxrate, `-bufsize:v:${i}`, r.bufsize]),
    // A tone-mapped stream is BT.709 now and must say so; leaving the BT.2020
    // / PQ / HLG tags on it would make a player "correct" it a second time.
    ...(toneMap.length > 0
      ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
      : []),
    ...(audio ? ["-c:a", "aac", "-ac", "1", ...rungs.flatMap((r, i) => [`-b:a:${i}`, r.audio])] : []),
    // Segment boundaries must be keyframe-aligned or players stall at each
    // join. At 6s segments and 25fps that is a keyframe every 150 frames.
    "-g", "150",
    "-keyint_min", "150",
    "-sc_threshold", "0",
    "-f", "hls",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", join(outDir, "v%v_%05d.ts"),
    "-master_pl_name", MASTER_PLAYLIST,
    "-var_stream_map", rungs.map((_, i) => (audio ? `v:${i},a:${i}` : `v:${i}`)).join(" "),
    join(outDir, "v%v.m3u8"),
  ];
}

/**
 * Whether a failed hlsEncodeArgs() run failed because the source has no audio
 * stream for its `-map 0:a:0`. The old single encode left stream selection to
 * ffmpeg, which skips a missing audio stream quietly; the ladder maps it by
 * name, which is fatal. ffmpeg 7.1 says "Stream map '' matches no streams",
 * 5.1 names the map, and both then say they failed to set it.
 */
export function missingAudioMap(ffmpegError: string): boolean {
  return /Stream map '[^']*' matches no streams|Failed to set value '0:a:0' for option 'map'/.test(ffmpegError);
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
    ...QUIET,
    "-y",
    "-ss", atSec.toFixed(2),
    "-i", input,
    "-frames:v", "1",
    "-vf", boundedScale(360),
    "-q:v", "6",
    output,
  ];
}
