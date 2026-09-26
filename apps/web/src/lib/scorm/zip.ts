// A small, STRICT reader for the ZIP archives a SCORM upload arrives as.
//
// ── WHY NOT A LIBRARY ────────────────────────────────────────────────────────
//
// None is in the workspace, and the ones that are common decide for themselves
// what to do with an archive that two readers would read differently -- which
// is exactly the archive an attacker sends. This reader refuses every such
// shape instead of choosing an interpretation:
//
//   - the central directory is the only list of files, and each local header
//     must name the same file (a mismatch is how one tool shows `a.html` while
//     another extracts `../../a.html`);
//   - no two entries may share bytes (overlapping entries are the "better zip
//     bomb": a kilobyte of central directory pointing at one deflate stream
//     many times);
//   - the size an entry DECLARES is the size it must inflate to -- the inflater
//     is stopped one byte past it, so a bomb's lie costs at most its declared
//     size in memory -- and its CRC must match;
//   - ZIP64, split archives, encryption and anything but stored/deflate are
//     refused rather than half-supported. A SCORM package is far below the
//     4 GiB where ZIP64 is needed.
//
// Nothing here writes to disk, and names are returned exactly as spelled:
// whether a name is SAFE is the caller's policy (lib/scorm/package.ts).

import { inflateRawSync } from "node:zlib";

export type ZipErrorCode = "not_zip" | "unsupported_zip" | "too_many_files" | "corrupt_entry" | "unsafe_path";

export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message: string,
    readonly paths?: string[],
  ) {
    super(message);
  }
}

export type ZipEntry = {
  /** The name exactly as the central directory spells it (UTF-8). */
  name: string;
  isDirectory: boolean;
  /** A Unix symlink entry: its "data" is a link target, never content. */
  isSymlink: boolean;
  /** Declared uncompressed size. read() refuses anything else. */
  size: number;
  /** Inflate and verify size and CRC. Throws ZipError("corrupt_entry"). */
  read(): Uint8Array;
};

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const EOCD_LEN = 22;
const CENTRAL_LEN = 46;
const LOCAL_LEN = 30;

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE), as ZIP records it. zlib.crc32 is Node >= 22.2 and not in @types/node 20. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Every entry of the archive, with its local header already checked against
 * the central directory. Entries are not inflated until read() is called.
 */
export function listZip(buf: Uint8Array, opts: { maxFiles: number }): ZipEntry[] {
  // The end-of-central-directory record: the last 22+ bytes, whose comment
  // length must reach exactly the end of the file. Trailing bytes after it are
  // another place for two readers to disagree, so there are none.
  let eocd = -1;
  const floor = Math.max(0, buf.length - EOCD_LEN - 0xffff);
  for (let i = buf.length - EOCD_LEN; i >= floor; i--) {
    if (u32(buf, i) === EOCD_SIG && i + EOCD_LEN + u16(buf, i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not_zip", "This is not a .zip archive, or it is incomplete.");

  if (eocd >= 20 && u32(buf, eocd - 20) === ZIP64_LOCATOR_SIG) {
    throw new ZipError("unsupported_zip", "ZIP64 archives are not accepted; re-export the package as a standard .zip.");
  }
  const disk = u16(buf, eocd + 4);
  const cdDisk = u16(buf, eocd + 6);
  const onThisDisk = u16(buf, eocd + 8);
  const total = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("unsupported_zip", "ZIP64 archives are not accepted; re-export the package as a standard .zip.");
  }
  if (disk !== 0 || cdDisk !== 0 || onThisDisk !== total) {
    throw new ZipError("unsupported_zip", "Split (multi-part) archives are not accepted.");
  }
  if (total > opts.maxFiles) {
    throw new ZipError("too_many_files", `The package has ${total} entries; at most ${opts.maxFiles} are accepted.`);
  }
  if (cdOffset + cdSize !== eocd) throw new ZipError("not_zip", "The archive's file list is not where the archive says it is.");

  type Raw = {
    name: string;
    nameBytes: Uint8Array;
    method: number;
    crc: number;
    comp: number;
    size: number;
    offset: number;
    isSymlink: boolean;
    dataStart: number;
    dataEnd: number;
  };
  const raws: Raw[] = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + CENTRAL_LEN > eocd || u32(buf, p) !== CENTRAL_SIG) {
      throw new ZipError("not_zip", "The archive's file list is damaged.");
    }
    const madeBy = u16(buf, p + 4);
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    const comp = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const diskStart = u16(buf, p + 34);
    const external = u32(buf, p + 38);
    const offset = u32(buf, p + 42);
    const next = p + CENTRAL_LEN + nameLen + extraLen + commentLen;
    if (next > eocd) throw new ZipError("not_zip", "The archive's file list is damaged.");
    const nameBytes = buf.subarray(p + CENTRAL_LEN, p + CENTRAL_LEN + nameLen);
    let name: string;
    try {
      name = utf8.decode(nameBytes);
    } catch {
      const lossy = new TextDecoder().decode(nameBytes);
      throw new ZipError("unsafe_path", `A file name is not valid UTF-8: ${lossy}`, [lossy]);
    }
    // Bit 0: traditional encryption; bit 6: strong encryption.
    if (flags & 0x0041) throw new ZipError("unsupported_zip", `Encrypted entries are not accepted: ${name}`, [name]);
    if (method !== 0 && method !== 8) {
      throw new ZipError("unsupported_zip", `Only stored and deflated entries are accepted: ${name}`, [name]);
    }
    if (comp === 0xffffffff || size === 0xffffffff || offset === 0xffffffff || diskStart !== 0) {
      throw new ZipError("unsupported_zip", `ZIP64 entries are not accepted: ${name}`, [name]);
    }
    // Unix "version made by" with S_IFLNK in the high half of the attributes.
    const isSymlink = madeBy >> 8 === 3 && ((external >>> 16) & 0o170000) === 0o120000;
    raws.push({ name, nameBytes, method, crc, comp, size, offset, isSymlink, dataStart: 0, dataEnd: 0 });
    p = next;
  }
  if (p !== eocd) throw new ZipError("not_zip", "The archive's file list is damaged.");

  for (const r of raws) {
    const o = r.offset;
    if (o + LOCAL_LEN > cdOffset || u32(buf, o) !== LOCAL_SIG) {
      throw new ZipError("corrupt_entry", `The archive is damaged at ${r.name}.`, [r.name]);
    }
    const localNameLen = u16(buf, o + 26);
    const localExtraLen = u16(buf, o + 28);
    if (!sameBytes(buf.subarray(o + LOCAL_LEN, o + LOCAL_LEN + localNameLen), r.nameBytes) || u16(buf, o + 8) !== r.method) {
      throw new ZipError("corrupt_entry", `The archive describes ${r.name} two different ways.`, [r.name]);
    }
    r.dataStart = o + LOCAL_LEN + localNameLen + localExtraLen;
    r.dataEnd = r.dataStart + r.comp;
    if (r.dataEnd > cdOffset) throw new ZipError("corrupt_entry", `The archive is damaged at ${r.name}.`, [r.name]);
  }

  const byOffset = [...raws].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < byOffset.length; i++) {
    const [a, b] = [byOffset[i - 1]!, byOffset[i]!];
    if (a.dataEnd > b.offset) {
      throw new ZipError("corrupt_entry", `${a.name} and ${b.name} overlap in the archive.`, [a.name, b.name]);
    }
  }

  return raws.map((r) => ({
    name: r.name,
    isDirectory: r.name.endsWith("/"),
    isSymlink: r.isSymlink,
    size: r.size,
    read(): Uint8Array {
      const data = buf.subarray(r.dataStart, r.dataEnd);
      let out: Uint8Array;
      if (r.method === 0) {
        out = data;
      } else {
        try {
          // One byte of headroom is all a lie gets: past the declared size the
          // inflater throws, instead of filling memory.
          out = inflateRawSync(data, { maxOutputLength: r.size + 1 });
        } catch {
          throw new ZipError("corrupt_entry", `${r.name} does not decompress to the size the archive declares.`, [r.name]);
        }
      }
      if (out.length !== r.size) {
        throw new ZipError("corrupt_entry", `${r.name} does not decompress to the size the archive declares.`, [r.name]);
      }
      if (crc32(out) !== r.crc) throw new ZipError("corrupt_entry", `${r.name} fails its checksum.`, [r.name]);
      return out;
    },
  }));
}
