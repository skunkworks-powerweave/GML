// A SCORM 1.2 upload is validated before a byte of it is stored -- executed
// against real archives, most of them hostile.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// CLAUDE.md locks SCORM into v1 and nothing implemented it (F41). The first
// thing an implementation has to get right is the archive itself: a .zip is
// attacker-shaped input, and this one ends up SERVED FROM OUR OWN ORIGIN. So
// validateScormPackage must refuse, with a reason an administrator can act on:
//   - names that leave the package (.., absolute, drive letters, backslashes);
//   - file types outside the allowlist (the served Content-Type comes from it);
//   - sizes that lie (a zip bomb declares little and inflates a lot), totals
//     over the cap, too many entries, a CRC that does not match;
//   - archive features that let two readers see different files: a local
//     header naming a different file than the central directory, two names
//     over the same bytes, ZIP64, encryption, symlinks;
//   - a manifest that is missing, not at the root, not SCORM 1.2, carries a
//     DOCTYPE, launches nothing, launches several SCOs, or points at a file the
//     archive does not contain.
// The archives are written by tests/behaviour/_zip.ts, which shares no code
// with the reader under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZip, manifest12, type ZipEntry } from "./_zip.js";
import { validateScormPackage, SCORM_LIMITS } from "../../apps/web/src/lib/scorm/package.ts";

const INDEX = "<!doctype html><html><head><script>var api = window.parent.API;</script></head><body>Hi</body></html>";

function pkg(extra: ZipEntry[] = [], manifest = manifest12()): Buffer {
  return buildZip([{ name: "imsmanifest.xml", data: manifest }, { name: "index.html", data: INDEX }, ...extra]);
}

function refused(buf: Buffer) {
  const r = validateScormPackage(buf);
  assert.equal(r.ok, false, "the package must be refused");
  return (r as Extract<typeof r, { ok: false }>).error;
}

test("a valid SCORM 1.2 package: title, launch file, every file typed from the allowlist, junk left out", () => {
  const r = validateScormPackage(
    pkg([
      { name: "css/", data: "" },
      { name: "css/site.css", data: "body{}" },
      { name: "js/app.js", data: "console.log(1)", method: 0 },
      { name: "media/intro.mp4", data: Buffer.alloc(64, 1) },
      { name: "__MACOSX/._index.html", data: "junk" },
      { name: "css/.DS_Store", data: "junk" },
    ]),
  );
  assert.equal(r.ok, true, JSON.stringify(!r.ok && r.error));
  const p = (r as Extract<typeof r, { ok: true }>).pkg;
  assert.equal(p.title, "Phonics & Reading", "the organization title, entities decoded");
  assert.equal(p.identifier, "com.example.course");
  assert.equal(p.launchPath, "index.html");
  assert.equal(p.launchQuery, "");
  const byPath = new Map(p.files.map((f) => [f.path, f]));
  assert.deepEqual([...byPath.keys()].sort(), ["css/site.css", "imsmanifest.xml", "index.html", "js/app.js", "media/intro.mp4"]);
  assert.equal(byPath.get("index.html")!.contentType, "text/html; charset=utf-8");
  assert.equal(byPath.get("js/app.js")!.contentType, "text/javascript; charset=utf-8");
  assert.equal(byPath.get("media/intro.mp4")!.contentType, "video/mp4");
  assert.equal(Buffer.from(byPath.get("index.html")!.read()).toString("utf8"), INDEX, "the bytes inflate back exactly");
  assert.equal(p.totalBytes, [...byPath.values()].reduce((n, f) => n + f.size, 0));
});

test("a name that leaves the package is refused, whatever its spelling", () => {
  for (const name of ["../evil.html", "a/../../evil.html", "/etc/evil.html", "C:/evil.html", "a\\..\\evil.html", "a//b.html", "./a.html", "a/./b.html", "a\u0000.html", "a\nb.html"]) {
    const e = refused(pkg([{ name, data: "x" }]));
    assert.equal(e.code, "unsafe_path", `${JSON.stringify(name)}: ${e.message}`);
    assert.deepEqual(e.paths, [name]);
  }
});

test("a file type outside the allowlist is refused, and the refusal names every such file", () => {
  const e = refused(pkg([{ name: "cgi/run.php", data: "<?php" }, { name: "tool.exe", data: "MZ" }, { name: "LICENSE", data: "mit" }, { name: "ok.png", data: "x" }]));
  assert.equal(e.code, "disallowed_type");
  assert.deepEqual(e.paths, ["cgi/run.php", "tool.exe", "LICENSE"]);
});

test("sizes that lie are caught: a bomb that inflates past its declared size, and a declared total over the cap", () => {
  // 4 MiB of zeros deflates to a few KB; declaring 10 bytes is the bomb's lie.
  const bomb = refused(pkg([{ name: "bomb.txt", data: Buffer.alloc(4 * 1024 * 1024), declaredSize: 10 }]));
  assert.equal(bomb.code, "corrupt_entry");
  assert.deepEqual(bomb.paths, ["bomb.txt"]);

  const short = refused(pkg([{ name: "short.txt", data: "abc", declaredSize: 9 }]));
  assert.equal(short.code, "corrupt_entry", "fewer bytes than declared");

  const huge = refused(pkg([{ name: "big.txt", data: "x", declaredSize: SCORM_LIMITS.maxEntryBytes + 1 }]));
  assert.equal(huge.code, "too_large", "refused from the declared size, before anything is inflated");

  const perEntry = Math.floor(SCORM_LIMITS.maxEntryBytes / 2);
  const entries: ZipEntry[] = [];
  for (let i = 0; i * perEntry <= SCORM_LIMITS.maxTotalBytes; i++) entries.push({ name: `p${i}.txt`, data: "x", declaredSize: perEntry });
  assert.equal(refused(pkg(entries)).code, "too_large", "the declared total is capped too");
});

test("a CRC that does not match the bytes is refused", () => {
  const e = refused(pkg([{ name: "a.txt", data: "hello", crc: 0x12345678 }]));
  assert.equal(e.code, "corrupt_entry");
});

test("too many entries is refused before any is read", () => {
  const entries: ZipEntry[] = [];
  for (let i = 0; i < SCORM_LIMITS.maxFiles; i++) entries.push({ name: `f${i}.txt`, data: "", method: 0 });
  assert.equal(refused(pkg(entries)).code, "too_many_files");
});

test("archive features that let two readers disagree are refused", () => {
  assert.equal(refused(pkg([{ name: "a.html", localName: "../../a.html", data: "x" }])).code, "corrupt_entry", "local and central names differ");
  assert.equal(refused(pkg([{ name: "a.txt", data: "x" }, { name: "b.txt", data: "", sharePreviousData: true }])).code, "corrupt_entry", "two names over one set of bytes");
  // An inflater ignores bytes after the end of a deflate stream, so an entry
  // that claims to run into the next one's header inflates cleanly: only the
  // overlap check stops one region of the archive being read as two files.
  const overlap = refused(pkg([{ name: "a.txt", data: "hello", extraCompressed: 12 }, { name: "b.txt", data: "world" }]));
  assert.equal(overlap.code, "corrupt_entry", overlap.message);
  assert.deepEqual(overlap.paths, ["a.txt", "b.txt"]);
  assert.equal(refused(pkg([{ name: "a.txt", data: "x" }, { name: "a.txt", data: "y" }])).code, "duplicate_path");
  assert.equal(refused(pkg([{ name: "a.txt", data: "x", flags: 1 }])).code, "unsupported_zip", "encrypted");
  assert.equal(refused(pkg([{ name: "a.txt", data: "x", method: 12 }])).code, "unsupported_zip", "bzip2");
  assert.equal(refused(pkg([{ name: "link.html", data: "/etc/passwd", method: 0, unixMode: 0o120777 }])).code, "unsafe_path", "symlink");
  assert.equal(refused(buildZip([{ name: "imsmanifest.xml", data: manifest12() }, { name: "index.html", data: INDEX }], { zip64: true })).code, "unsupported_zip", "ZIP64");
});

test("something that is not a zip, or is cut short, is refused", () => {
  assert.equal(refused(Buffer.from("not a zip at all")).code, "not_zip");
  assert.equal(refused(Buffer.alloc(0)).code, "not_zip");
  const whole = pkg();
  assert.equal(refused(whole.subarray(0, whole.length - 30)).code, "not_zip", "truncated: no end-of-central-directory");
  const garbled = Buffer.from(whole);
  garbled.fill(0, 0, 40);
  assert.equal(refused(garbled).code, "corrupt_entry", "a local header that is not one");
});

test("the manifest must exist at the root, parse, and be SCORM 1.2", () => {
  assert.equal(refused(buildZip([{ name: "index.html", data: INDEX }])).code, "no_manifest");
  assert.equal(
    refused(buildZip([{ name: "course/imsmanifest.xml", data: manifest12() }, { name: "course/index.html", data: INDEX }])).code,
    "no_manifest",
    "SCORM requires imsmanifest.xml at the package root",
  );
  assert.equal(refused(pkg([], "<manifest><organizations>")).code, "bad_manifest", "unclosed");
  assert.equal(refused(pkg([], "<notamanifest/>")).code, "bad_manifest");
  const doctype = refused(pkg([], manifest12({ prolog: '<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x "xx">]>' })));
  assert.equal(doctype.code, "bad_manifest", "no DTD, so no entity expansion");
  assert.match(doctype.message, /DOCTYPE/, "refused as a declaration, not by accident");
  assert.equal(refused(pkg([], manifest12({ title: "&unknown;" }))).code, "bad_manifest");
  assert.equal(refused(pkg([], manifest12({ schemaversion: "2004 4th Edition" }))).code, "unsupported_version");
  assert.equal(refused(pkg([], manifest12({ schemaversion: "CAM 1.3" }))).code, "unsupported_version");
});

test("exactly one launchable item, whose file is in the archive", () => {
  const two = refused(
    pkg(
      [{ name: "two.html", data: INDEX }],
      manifest12({ items: [{ id: "A", ref: "RA", href: "index.html" }, { id: "B", ref: "RB", href: "two.html" }] }),
    ),
  );
  assert.equal(two.code, "multiple_scos");
  assert.equal(refused(pkg([], manifest12({ items: [] }))).code, "no_launch");
  assert.equal(refused(pkg([], manifest12({ href: "missing.html" }))).code, "missing_launch_file");
  assert.equal(refused(pkg([], manifest12({ href: "https://evil.example/x.html" }))).code, "missing_launch_file", "never an external launch");
  assert.equal(refused(pkg([], manifest12({ href: "../index.html" }))).code, "missing_launch_file");
});

test("the launch href keeps its query, is percent-decoded to the file, and honours xml:base; mastery score and launch data are read", () => {
  const r = validateScormPackage(
    buildZip([
      {
        name: "imsmanifest.xml",
        data: manifest12({
          href: "my%20lesson.html?lang=bo&amp;mode=1",
          resourceAttrs: 'xml:base="sco/"',
          itemExtra: "<adlcp:masteryscore>80</adlcp:masteryscore><adlcp:datafromlms>start=2</adlcp:datafromlms>",
          schemaversion: null,
        }),
      },
      { name: "sco/my lesson.html", data: INDEX },
    ]),
  );
  assert.equal(r.ok, true, JSON.stringify(!r.ok && r.error));
  const p = (r as Extract<typeof r, { ok: true }>).pkg;
  assert.equal(p.launchPath, "sco/my lesson.html");
  assert.equal(p.launchQuery, "?lang=bo&mode=1");
  assert.equal(p.masteryScore, 80);
  assert.equal(p.launchData, "start=2");
});

test("a SCORM 2004 manifest with no schemaversion is still recognised by its scormType attribute", () => {
  const m = manifest12({ schemaversion: null }).replace("adlcp:scormtype", "adlcp:scormType");
  assert.equal(refused(pkg([], m)).code, "unsupported_version");
});

test("the manifest parser holds against deep nesting and a manifest that is not UTF-8 text", () => {
  const deep = "<manifest>" + "<a>".repeat(500) + "</a>".repeat(500) + "</manifest>";
  assert.equal(refused(pkg([], deep)).code, "bad_manifest");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(manifest12(), "utf16le")]);
  const r = validateScormPackage(buildZip([{ name: "imsmanifest.xml", data: utf16 }, { name: "index.html", data: INDEX }]));
  assert.equal(r.ok, true, "a UTF-16 manifest with a byte-order mark is read");
});
