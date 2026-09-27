// Is this .zip a SCORM 1.2 package this LMS will store and serve?
//
// Every check runs before a byte is stored, and in an order that keeps a
// hostile archive cheap to refuse: structure, then names, then DECLARED sizes
// (so a bomb is refused before it is inflated), then types, then every entry
// is inflated once and checked against its declared size and CRC -- one entry
// in memory at a time -- and only then is the manifest read.
//
// A refusal carries a code, a sentence an administrator can act on, and the
// offending paths. Pure: no Storage, no database. lib/scorm/ingest.ts stores
// what this accepts.

import { listZip, ZipError, type ZipEntry } from "./zip";
import { decodeManifest, ManifestError, readManifest } from "./manifest";
import { scormContentType } from "./files";
import { scormMessage, scormText, type ScormMessage } from "./messages";

export const SCORM_LIMITS = {
  /**
   * The .zip itself. Caddy refuses request bodies over 25 MB
   * (docker/Caddyfile, request_body), so an upload form offering more would
   * fail at the edge with no explanation; 20 MiB leaves the multipart overhead
   * room. A course meant for 2G phones in Ladakh should be far smaller.
   */
  maxPackageBytes: 20 * 1024 * 1024,
  maxFiles: 2000,
  /** One file, uncompressed (also the bucket's per-object limit, _post/009). */
  maxEntryBytes: 50 * 1024 * 1024,
  /** Everything, uncompressed. */
  maxTotalBytes: 100 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
} as const;

export type ScormErrorCode =
  | "too_large"
  | "not_zip"
  | "unsupported_zip"
  | "too_many_files"
  | "corrupt_entry"
  | "unsafe_path"
  | "duplicate_path"
  | "disallowed_type"
  | "no_manifest"
  | "bad_manifest"
  | "unsupported_version"
  | "no_launch"
  | "multiple_scos"
  | "missing_launch_file";

/**
 * A refusal: its code, the sentence an administrator can act on (English in
 * `message`; `detail` is it as a message key, for her own language -- see
 * ingest.ts), and the offending paths.
 */
export type ScormPackageError = { code: ScormErrorCode; message: string; detail: ScormMessage; paths?: string[] };

export type ScormFile = {
  /** Package-relative path, exactly as in the archive. */
  path: string;
  size: number;
  contentType: string;
  /** The verified bytes. Inflates on each call; nothing is retained. */
  read(): Uint8Array;
};

export type ValidScormPackage = {
  identifier: string;
  title: string;
  launchPath: string;
  launchQuery: string;
  masteryScore: number | null;
  launchData: string | null;
  files: ScormFile[];
  totalBytes: number;
};

export const MANIFEST_PATH = "imsmanifest.xml";

/**
 * Operating-system litter an archiver adds: never content, never stored.
 * Still subject to the name checks, so it cannot smuggle a traversal past them.
 */
function isLitter(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return path.startsWith("__MACOSX/") || base === ".DS_Store" || base === "Thumbs.db" || base === "desktop.ini";
}

/**
 * A name that stays inside the package: relative, "/"-separated, no empty,
 * "." or ".." segment, no backslash, no control character, no drive letter.
 * A directory entry's single trailing "/" is allowed.
 */
export function isSafePackagePath(name: string): boolean {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (path === "" || path.length > 512) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const fail = (code: ScormErrorCode, detail: ScormMessage, paths?: string[]) =>
  ({ ok: false, error: { code, message: scormText(detail), detail, ...(paths ? { paths } : {}) } }) as const;

/** The paths as a list, the first five and a count of the rest. The names are data. */
const list = (paths: string[]): string | ScormMessage =>
  paths.length > 5 ? scormMessage("listMore", { list: paths.slice(0, 5).join(", "), more: paths.length - 5 }) : paths.join(", ");

export function validateScormPackage(
  bytes: Uint8Array,
): { ok: true; pkg: ValidScormPackage } | { ok: false; error: ScormPackageError } {
  if (bytes.length > SCORM_LIMITS.maxPackageBytes) {
    return fail("too_large", scormMessage("tooLarge", { mb: SCORM_LIMITS.maxPackageBytes / 1024 / 1024 }));
  }

  let entries: ZipEntry[];
  try {
    entries = listZip(bytes, { maxFiles: SCORM_LIMITS.maxFiles });
  } catch (err) {
    if (err instanceof ZipError) return fail(err.code, err.detail, err.paths);
    throw err;
  }

  const unsafe = entries.filter((e) => e.isSymlink || !isSafePackagePath(e.name)).map((e) => e.name);
  if (unsafe.length) return fail("unsafe_path", scormMessage("unsafePath", { paths: list(unsafe) }), unsafe);

  const content = entries.filter((e) => !e.isDirectory && !isLitter(e.name));
  const seen = new Set<string>();
  const dupes = content.filter((e) => (seen.has(e.name) ? true : (seen.add(e.name), false))).map((e) => e.name);
  if (dupes.length) return fail("duplicate_path", scormMessage("duplicatePath", { paths: list(dupes) }), dupes);

  const big = content.filter((e) => e.size > SCORM_LIMITS.maxEntryBytes).map((e) => e.name);
  if (big.length) {
    return fail("too_large", scormMessage("entriesTooLarge", { mb: SCORM_LIMITS.maxEntryBytes / 1024 / 1024, paths: list(big) }), big);
  }
  const totalBytes = content.reduce((n, e) => n + e.size, 0);
  if (totalBytes > SCORM_LIMITS.maxTotalBytes) {
    return fail("too_large", scormMessage("unpacksTooLarge", { mb: SCORM_LIMITS.maxTotalBytes / 1024 / 1024 }));
  }

  const untyped = content.filter((e) => scormContentType(e.name) === null).map((e) => e.name);
  if (untyped.length) return fail("disallowed_type", scormMessage("disallowedType", { paths: list(untyped) }), untyped);

  let manifestBytes: Uint8Array | null = null;
  for (const e of content) {
    try {
      const data = e.read();
      if (e.name === MANIFEST_PATH) manifestBytes = data;
    } catch (err) {
      if (err instanceof ZipError) return fail(err.code, err.detail, err.paths);
      throw err;
    }
  }
  if (!manifestBytes) return fail("no_manifest", scormMessage("noManifest"));
  if (manifestBytes.length > SCORM_LIMITS.maxManifestBytes) return fail("bad_manifest", scormMessage("manifestTooLarge"));

  let manifest;
  try {
    manifest = readManifest(decodeManifest(manifestBytes));
  } catch (err) {
    if (err instanceof ManifestError) return fail(err.code, err.detail);
    throw err;
  }
  if (!manifest.launchPath || !seen.has(manifest.launchPath)) {
    return fail("missing_launch_file", scormMessage("missingLaunchFile", { href: manifest.launchHref }));
  }

  return {
    ok: true,
    pkg: {
      identifier: manifest.identifier,
      title: manifest.title,
      launchPath: manifest.launchPath,
      launchQuery: manifest.launchQuery,
      masteryScore: manifest.masteryScore,
      launchData: manifest.launchData,
      totalBytes,
      files: content.map((e) => ({ path: e.name, size: e.size, contentType: scormContentType(e.name)!, read: () => e.read() })),
    },
  };
}
