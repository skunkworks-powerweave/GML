// Stand-ins for the external tools the worker spawns (ffprobe, ffmpeg, nice):
// a directory to put FIRST on the worker's PATH, holding one executable per
// tool, each of which runs a small ES module the test writes.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Some worker defects are about what it does when a TOOL misbehaves -- one that
// never exits, one that writes an undecodable rendition, one that fails in one
// particular way -- and a real ffmpeg does none of those on demand. The worker
// spawns its tools by name with no shell, so a stand-in has to be a real
// executable that PATH resolves:
//
//   POSIX    a `#!/bin/sh` script that execs node on the module, so the tool's
//            pid IS the module's and a signal to one is a signal to the other;
//   Windows  where spawn() resolves only .exe and .com, a launcher compiled
//            once with the .NET Framework's csc.exe (part of every Windows
//            10/11) that runs node on the module with the command line it was
//            given, and exits with its exit code.
//
// The module sees the tool's arguments as process.argv.slice(2), and should be
// given absolute paths (on Windows it runs in the temp directory). Every call
// is recorded (calls()), with the pid of the process running the module.
//
// On Windows the module runs in the launcher's CHILD, which killing the
// launcher does not kill; so every module exits by itself once the process
// that started it is gone, and a stand-in that "never exits" cannot outlive
// the test.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const CSC = ["Framework64", "Framework"]
  .map((fw) => join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", fw, "v4.0.30319", "csc.exe"))
  .find((p) => existsSync(p));

/** Why stand-ins cannot be made here, or false when they can. For `{ skip }`. */
export function standInSkip(): string | false {
  if (process.platform === "win32" && !CSC) {
    return "no csc.exe (.NET Framework 4) to build a Windows stand-in executable with";
  }
  return false;
}

const LAUNCHER_CS = (node: string) => `
using System;
using System.Diagnostics;
using System.IO;
static class StandIn {
  static int Main() {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    // Out of the caller's directory: Windows keeps a process's working
    // directory open, and the worker's is removed as its test ends.
    Environment.CurrentDirectory = Path.GetTempPath();
    // The command line minus argv[0], exactly as the caller quoted it, so node
    // parses the same arguments this process was given.
    string cmd = Environment.CommandLine;
    int cut = cmd.StartsWith("\\"") ? cmd.IndexOf('"', 1) + 1 : cmd.IndexOf(' ');
    string rest = cut <= 0 ? "" : cmd.Substring(cut);
    ProcessStartInfo psi = new ProcessStartInfo(@"${node.replace(/"/g, '""')}",
      "\\"" + Path.ChangeExtension(self, ".mjs") + "\\"" + rest);
    psi.UseShellExecute = false;
    psi.WorkingDirectory = Environment.CurrentDirectory;
    using (Process p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
  }
}
`;

let launcher: string | undefined;
/** The compiled Windows launcher, built once per test process. */
function windowsLauncher(): string {
  if (launcher) return launcher;
  const dir = mkdtempSync(join(tmpdir(), "gml-standin-launcher-"));
  writeFileSync(join(dir, "standin.cs"), LAUNCHER_CS(process.execPath));
  execFileSync(CSC!, ["/nologo", "/target:exe", `/out:${join(dir, "standin.exe")}`, join(dir, "standin.cs")]);
  launcher = join(dir, "standin.exe");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Still in use; it is only a 5 KB launcher in the temp directory.
    }
  });
  return launcher;
}

/** Prepended to every module: record the call, and die with whoever started it. */
const PREAMBLE = (callsFile: string) => `
import { appendFileSync as __append } from "node:fs";
__append(${JSON.stringify(callsFile)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
{
  const parent = process.ppid;
  setInterval(() => {
    try { process.kill(parent, 0); } catch { process.exit(137); }
  }, 200).unref();
}
`;

export type StandIns = {
  dir: string;
  /** The env that puts the stand-ins first on PATH (the key PATH is spelled with here). */
  env: Record<string, string>;
  /** Every call a tool has had so far, oldest first. */
  calls(tool: string): Array<{ pid: number; args: string[] }>;
  close(): Promise<void>;
};

/** Stand-ins for `tools`: { name: module source }. */
export function standIns(tools: Record<string, string>): StandIns {
  const dir = mkdtempSync(join(tmpdir(), "gml-standin-"));
  const callsFile = (tool: string) => join(dir, `${tool}.calls`);
  for (const [tool, body] of Object.entries(tools)) {
    writeFileSync(join(dir, `${tool}.mjs`), PREAMBLE(callsFile(tool)) + body);
    if (process.platform === "win32") {
      copyFileSync(windowsLauncher(), join(dir, `${tool}.exe`));
    } else {
      const sh = join(dir, tool);
      writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, `${tool}.mjs`)}" "$@"\n`);
      chmodSync(sh, 0o755);
    }
  }
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return {
    dir,
    env: { [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ""}` },
    calls: (tool) =>
      existsSync(callsFile(tool))
        ? readFileSync(callsFile(tool), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
    // Retried: a Windows stand-in takes a moment to notice its launcher is gone.
    // Retried: on Windows a running .exe cannot be deleted, and a stand-in
    // takes a moment to notice that the worker behind it is gone.
    close: async () => {
      for (let i = 0; ; i += 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch (err) {
          if (i >= 50) throw err;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    },
  };
}

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stand-in ffprobe for a readable source: a `width`x`height` video of
 * `duration` seconds, with sound when `audio`, whose renditions probe as 8-bit
 * 4:2:0 H.264 High unless `rendition` says otherwise.
 */
export function probeModule(
  opts: { width?: number; height?: number; duration?: number; audio?: boolean; rendition?: Record<string, string> } = {},
): string {
  const source = {
    streams: [
      { codec_type: "video", width: opts.width ?? 320, height: opts.height ?? 180 },
      ...(opts.audio === false ? [] : [{ codec_type: "audio" }]),
    ],
    format: { duration: String(opts.duration ?? 2) },
  };
  const rendition = { streams: [opts.rendition ?? { codec_name: "h264", profile: "High", pix_fmt: "yuv420p" }] };
  return `
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify(args.includes("-select_streams") ? ${JSON.stringify(rendition)} : ${JSON.stringify(source)}));
`;
}

/**
 * A stand-in ffmpeg that "encodes": for the HLS encode it writes a master
 * playlist, and a media playlist and one segment per rung, where the real one
 * would; for the poster, a small file at the output path.
 */
export const FFMPEG_WRITES_OUTPUT = `
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const seg = args.indexOf("-hls_segment_filename");
if (seg >= 0) {
  const out = dirname(args[seg + 1]);
  const rungs = args[args.indexOf("-var_stream_map") + 1].split(" ").length;
  const master = ["#EXTM3U"];
  for (let i = 0; i < rungs; i += 1) {
    writeFileSync(join(out, "v" + i + "_00000.ts"), Buffer.alloc(188, 0x47));
    writeFileSync(join(out, "v" + i + ".m3u8"), "#EXTM3U\\n#EXTINF:2,\\nv" + i + "_00000.ts\\n#EXT-X-ENDLIST\\n");
    master.push("#EXT-X-STREAM-INF:BANDWIDTH=" + (i + 1) * 250000, "v" + i + ".m3u8");
  }
  writeFileSync(join(out, "master.m3u8"), master.join("\\n") + "\\n");
} else {
  writeFileSync(args[args.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
}
`;

/** A stand-in that never exits of its own accord (until whoever started it is gone). */
export const HANGS = `setInterval(() => {}, 1 << 30);\n`;
