// imsmanifest.xml -> what a SCORM 1.2 launch needs.
//
// SCOPE, DELIBERATELY NARROW. This LMS launches ONE SCO per package: the
// single launchable item of the default organization. A package whose
// organization has several launchable items is refused with that reason,
// rather than accepted with all but the first unreachable -- a learner would
// be told she had finished a course she had seen a fraction of. SCORM 2004
// packages (schemaversion "2004 ..." / "CAM 1.3", the 1.3 adlcp namespace, or
// the 2004 spelling `scormType`) are refused too: their content looks for
// API_1484_11, which this runtime does not provide.

import { childNamed, childrenNamed, parseXml, XmlError, type XmlElement } from "./xml";

export type ManifestErrorCode = "bad_manifest" | "unsupported_version" | "no_launch" | "multiple_scos" | "missing_launch_file";

export class ManifestError extends Error {
  constructor(
    readonly code: ManifestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ManifestInfo = {
  identifier: string;
  title: string;
  /**
   * The launch file, relative to the package root and percent-DECODED, i.e.
   * spelled as it is in the archive; null when the href cannot name a file in
   * the package (external, or climbing out of it).
   */
  launchPath: string | null;
  /** The href as written, for error messages. */
  launchHref: string;
  /** Everything from the first ? or #, kept for the launch URL ("" if none). */
  launchQuery: string;
  /** adlcp:masteryscore, 0-100, when the manifest gives one. */
  masteryScore: number | null;
  /** adlcp:datafromlms, offered to the SCO as cmi.launch_data. */
  launchData: string | null;
};

const TITLE_MAX = 240;
const LAUNCH_DATA_MAX = 4096;

/** Decode a manifest's bytes: a UTF-16 byte-order mark is honoured, otherwise UTF-8. */
export function decodeManifest(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * A package-relative href -> the archive path it names, or null.
 *
 * Absolute URLs, protocol-relative ones, and anything that climbs with ".."
 * are not files of this package. "./" prefixes are dropped; the rest is
 * percent-decoded segment by segment, because an href is a URI and the archive
 * holds file names ("my%20lesson.html" is the file "my lesson.html").
 */
export function hrefToPath(href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.includes("\\")) return null;
  let path = href;
  while (path.startsWith("./")) path = path.slice(2);
  const segments = path.split("/");
  const out: string[] = [];
  for (const raw of segments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\")) return null;
    out.push(seg);
  }
  return out.join("/");
}

function textOf(el: XmlElement | undefined): string {
  return (el?.text ?? "").trim();
}

export function readManifest(xml: string): ManifestInfo {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (err) {
    throw new ManifestError("bad_manifest", `imsmanifest.xml is not valid XML: ${err instanceof XmlError ? err.message : String(err)}`);
  }
  if (root.local !== "manifest") throw new ManifestError("bad_manifest", "imsmanifest.xml does not contain a <manifest>.");

  const version = textOf(childNamed(childNamed(root, "metadata") ?? root, "schemaversion"));
  const resourcesEl = childNamed(root, "resources");
  const resources = resourcesEl ? childrenNamed(resourcesEl, "resource") : [];
  const namespaces = [...root.attrs.values()].join(" ");
  const is2004 =
    (version !== "" && !/^1\.2(\.\d+)*$/.test(version)) ||
    /adlcp_v1p3|imsss/i.test(namespaces) ||
    resources.some((r) => [...r.attrs.keys()].some((k) => k.endsWith(":scormType") || k === "scormType"));
  if (is2004) {
    throw new ManifestError(
      "unsupported_version",
      `This is a SCORM 2004 package${version ? ` (${version})` : ""}. Only SCORM 1.2 packages are supported; re-export it as SCORM 1.2.`,
    );
  }

  const byId = new Map<string, XmlElement>();
  for (const r of resources) {
    const id = r.attrs.get("identifier");
    if (id) byId.set(id, r);
  }

  const orgsEl = childNamed(root, "organizations");
  const orgs = orgsEl ? childrenNamed(orgsEl, "organization") : [];
  const wanted = orgsEl?.attrs.get("default");
  const org = orgs.find((o) => o.attrs.get("identifier") === wanted) ?? orgs[0];
  if (!org) throw new ManifestError("no_launch", "The manifest has no organization, so there is nothing to launch.");

  // Every item with a resource that has an href, depth-first.
  const launchable: Array<{ item: XmlElement; resource: XmlElement }> = [];
  const walk = (el: XmlElement) => {
    for (const item of childrenNamed(el, "item")) {
      const ref = item.attrs.get("identifierref");
      if (ref) {
        const resource = byId.get(ref);
        if (!resource) throw new ManifestError("bad_manifest", `Item ${item.attrs.get("identifier") ?? "?"} refers to a resource (${ref}) the manifest does not define.`);
        if (resource.attrs.get("href")) launchable.push({ item, resource });
      }
      walk(item);
    }
  };
  walk(org);
  if (launchable.length === 0) throw new ManifestError("no_launch", "The manifest's organization has no item that can be launched.");
  if (launchable.length > 1) {
    throw new ManifestError(
      "multiple_scos",
      `The package has ${launchable.length} launchable items; only single-SCO packages are supported. Export the course as one SCO.`,
    );
  }

  const { item, resource } = launchable[0]!;
  const href = (resourcesEl?.attrs.get("xml:base") ?? "") + (resource.attrs.get("xml:base") ?? "") + resource.attrs.get("href")!;
  const cut = href.search(/[?#]/);
  const pathPart = cut < 0 ? href : href.slice(0, cut);
  const mastery = Number(textOf(childNamed(item, "masteryscore")));
  const launchData = textOf(childNamed(item, "datafromlms"));
  const title =
    textOf(childNamed(org, "title")) || textOf(childNamed(item, "title")) || root.attrs.get("identifier") || "Untitled package";

  return {
    identifier: root.attrs.get("identifier") ?? "",
    title: title.slice(0, TITLE_MAX),
    launchPath: hrefToPath(pathPart),
    launchHref: href,
    launchQuery: cut < 0 ? "" : href.slice(cut),
    masteryScore: textOf(childNamed(item, "masteryscore")) !== "" && mastery >= 0 && mastery <= 100 ? mastery : null,
    launchData: launchData ? launchData.slice(0, LAUNCH_DATA_MAX) : null,
  };
}
