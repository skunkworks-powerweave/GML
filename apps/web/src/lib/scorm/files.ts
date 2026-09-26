// The file types a SCORM package may contain, and the Content-Type each is
// SERVED with.
//
// One table does both jobs on purpose. The content route never trusts a type
// stored with an object or sniffed from its bytes: it serves what this table
// says for the extension (with nosniff), and an upload containing any other
// extension is refused. So "which files can run as what on our origin" has a
// single answer, readable here.
//
// Flash (.swf), server scripts, executables and archives are absent: nothing
// in a browser-delivered SCORM 1.2 course needs them, and several are exactly
// what an upload filter exists to stop.

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  xsd: "application/xml; charset=utf-8",
  dtd: "application/xml-dtd",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf",
};

/** The Content-Type to serve `path` with, or null when the type is not allowed. */
export function scormContentType(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return Object.prototype.hasOwnProperty.call(TYPES, base.slice(dot + 1).toLowerCase())
    ? TYPES[base.slice(dot + 1).toLowerCase()]!
    : null;
}
