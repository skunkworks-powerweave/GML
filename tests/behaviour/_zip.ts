// A ZIP WRITER for the SCORM tests, able to write the archives a real tool
// never would: a name that climbs out of the package, a size that lies, a
// local header that disagrees with the central directory, an encrypted or
// symlinked entry, two names over the same bytes.
//
// Deliberately independent of apps/web/src/lib/scorm/zip.ts (the reader under
// test): a reader checked only against its own writer proves nothing.

import { deflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  data: Buffer | string;
  /** 0 stored, 8 deflate (default), anything else to test refusal. */
  method?: number;
  /** A different name in the LOCAL header than in the central directory. */
  localName?: string;
  /** Override the uncompressed size both headers declare. */
  declaredSize?: number;
  /** Override the CRC both headers declare. */
  crc?: number;
  /** General-purpose flags (bit 0 = encrypted). */
  flags?: number;
  /** Unix mode in the high 16 bits of the external attributes (e.g. 0o120777 for a symlink). */
  unixMode?: number;
  /** Point this central-directory entry at the previous entry's local header. */
  sharePreviousData?: boolean;
  /** Declare this many more compressed bytes than there are (runs into the next entry). */
  extraCompressed?: number;
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive. `zip64` writes a ZIP64 end-of-central-directory locator. */
export function buildZip(entries: ZipEntry[], opts: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let previous: { offset: number; header: Buffer; crc: number; comp: number; size: number; method: number } | null = null;

  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const size = e.declaredSize ?? data.length;
    const flags = (e.flags ?? 0) | 0x0800; // UTF-8 names
    const name = Buffer.from(e.name, "utf8");

    let localOffset = offset;
    let comp = compressed.length + (e.extraCompressed ?? 0);
    let entryCrc = crc;
    let entrySize = size;
    let entryMethod = method;
    if (e.sharePreviousData && previous) {
      localOffset = previous.offset;
      comp = previous.comp;
      entryCrc = previous.crc;
      entrySize = previous.size;
      entryMethod = previous.method;
    } else {
      const localName = Buffer.from(e.localName ?? e.name, "utf8");
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(flags, 6);
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(0, 10);
      lh.writeUInt16LE(0x21, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(comp, 18);
      lh.writeUInt32LE(size, 22);
      lh.writeUInt16LE(localName.length, 26);
      lh.writeUInt16LE(0, 28);
      const local = Buffer.concat([lh, localName, compressed]);
      locals.push(local);
      previous = { offset, header: lh, crc, comp, size, method };
      offset += local.length;
    }

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(entryMethod, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(entryCrc, 16);
    ch.writeUInt32LE(comp, 20);
    ch.writeUInt32LE(entrySize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(e.unixMode !== undefined ? ((e.unixMode & 0xffff) << 16) >>> 0 : 0, 38);
    ch.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([ch, name]));
  }

  const cd = Buffer.concat(centrals);
  const parts = [...locals, cd];
  if (opts.zip64) {
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    parts.push(loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}

/** A minimal, valid SCORM 1.2 manifest launching `href`. */
export function manifest12(opts: {
  href?: string;
  title?: string;
  items?: Array<{ id: string; ref: string; href: string }>;
  itemExtra?: string;
  schemaversion?: string | null;
  resourceAttrs?: string;
  prolog?: string;
} = {}): string {
  const items = opts.items ?? [{ id: "ITEM1", ref: "RES1", href: opts.href ?? "index.html" }];
  const schemaversion =
    opts.schemaversion === null ? "" : `<schemaversion>${opts.schemaversion ?? "1.2"}</schemaversion>`;
  return `${opts.prolog ?? '<?xml version="1.0" encoding="UTF-8"?>'}
<manifest identifier="com.example.course" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema>${schemaversion}</metadata>
  <organizations default="ORG1">
    <organization identifier="ORG1">
      <title>${opts.title ?? "Phonics &amp; Reading"}</title>
      ${items
        .map(
          (i) => `<item identifier="${i.id}" identifierref="${i.ref}"><title>${i.id}</title>${opts.itemExtra ?? ""}</item>`,
        )
        .join("\n")}
    </organization>
  </organizations>
  <resources>
    ${items
      .map(
        (i) =>
          `<resource identifier="${i.ref}" type="webcontent" adlcp:scormtype="sco" href="${i.href}" ${opts.resourceAttrs ?? ""}><file href="${i.href}"/></resource>`,
      )
      .join("\n")}
  </resources>
</manifest>`;
}
