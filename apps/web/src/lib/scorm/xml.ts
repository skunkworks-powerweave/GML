// A minimal XML parser for imsmanifest.xml, and nothing else.
//
// A manifest is a small tree of elements, attributes and text. This reads
// exactly that, and REFUSES a DOCTYPE outright: no DTD means no entity
// definitions, so there is no entity expansion to bomb ("billion laughs") and
// no external entity to fetch. Only the five predefined entities and numeric
// character references are decoded; anything else is an error, as it is in
// XML. Depth is bounded so a pathological nesting cannot exhaust the stack.
//
// Namespaces are not resolved: SCORM tools spell the adlcp prefix
// consistently, and callers match on an element's local name.

export class XmlError extends Error {}

export type XmlElement = {
  /** The qualified name as written, e.g. "adlcp:masteryscore". */
  name: string;
  /** The part after any prefix, e.g. "masteryscore". */
  local: string;
  attrs: Map<string, string>;
  children: XmlElement[];
  /** Concatenated character data directly inside this element. */
  text: string;
};

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&([^;&\s]*);?/g, (whole, body: string) => {
    if (!whole.endsWith(";")) throw new XmlError("A bare & is not allowed in XML.");
    if (body in PREDEFINED) return PREDEFINED[body]!;
    const code = /^#x[0-9a-f]+$/i.test(body) ? parseInt(body.slice(2), 16) : /^#[0-9]+$/.test(body) ? parseInt(body.slice(1), 10) : NaN;
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) throw new XmlError(`Unknown entity &${body};`);
    return String.fromCodePoint(code);
  });
}

const NAME = /^[A-Za-z_:][\w.\-:]*/;
const localOf = (name: string) => name.slice(name.lastIndexOf(":") + 1);

export function parseXml(src: string, opts: { maxDepth?: number } = {}): XmlElement {
  const maxDepth = opts.maxDepth ?? 64;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const expect = (token: string, from: number): number => {
    const at = src.indexOf(token, from);
    if (at < 0) throw new XmlError(`Unterminated markup: expected ${token}.`);
    return at;
  };

  while (i < src.length) {
    if (src.startsWith("<?", i)) {
      i = expect("?>", i + 2) + 2;
    } else if (src.startsWith("<!--", i)) {
      i = expect("-->", i + 4) + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = expect("]]>", i + 9);
      const top = stack.at(-1);
      if (!top) throw new XmlError("Character data outside the root element.");
      top.text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith("<!", i)) {
      throw new XmlError("A DOCTYPE or other declaration is not accepted in a manifest.");
    } else if (src.startsWith("</", i)) {
      const end = expect(">", i + 2);
      const name = src.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlError(`Mismatched closing tag </${name}>.`);
      i = end + 1;
    } else if (src[i] === "<") {
      const m = NAME.exec(src.slice(i + 1, i + 257));
      if (!m) throw new XmlError("A tag with no valid name.");
      const el: XmlElement = { name: m[0], local: localOf(m[0]), attrs: new Map(), children: [], text: "" };
      i += 1 + m[0].length;
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(src[i] ?? "")) i++;
        if (src.startsWith("/>", i)) {
          selfClosing = true;
          i += 2;
          break;
        }
        if (src[i] === ">") {
          i += 1;
          break;
        }
        const a = NAME.exec(src.slice(i, i + 257));
        if (!a) throw new XmlError(`A malformed attribute on <${el.name}>.`);
        i += a[0].length;
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] !== "=") throw new XmlError(`Attribute ${a[0]} has no value.`);
        i++;
        while (/\s/.test(src[i] ?? "")) i++;
        const quote = src[i];
        if (quote !== '"' && quote !== "'") throw new XmlError(`Attribute ${a[0]} is not quoted.`);
        const end = expect(quote, i + 1);
        if (el.attrs.has(a[0])) throw new XmlError(`Attribute ${a[0]} appears twice on <${el.name}>.`);
        el.attrs.set(a[0], decodeEntities(src.slice(i + 1, end)));
        i = end + 1;
      }
      const parent = stack.at(-1);
      if (parent) parent.children.push(el);
      else if (root) throw new XmlError("More than one root element.");
      else root = el;
      if (!selfClosing) {
        if (stack.length >= maxDepth) throw new XmlError("The manifest is nested too deeply.");
        stack.push(el);
      }
    } else {
      const next = src.indexOf("<", i);
      const end = next < 0 ? src.length : next;
      const text = src.slice(i, end);
      const top = stack.at(-1);
      if (top) top.text += decodeEntities(text);
      else if (text.trim()) throw new XmlError("Text outside the root element.");
      i = end;
    }
  }
  if (stack.length) throw new XmlError(`<${stack.at(-1)!.name}> is never closed.`);
  if (!root) throw new XmlError("No root element.");
  return root;
}

/** Direct children with this local name. */
export const childrenNamed = (el: XmlElement, local: string) => el.children.filter((c) => c.local === local);

/** The first direct child with this local name. */
export const childNamed = (el: XmlElement, local: string) => el.children.find((c) => c.local === local);

/** An attribute by local name ("scormtype" finds "adlcp:scormtype"), matched exactly. */
export function attrLocal(el: XmlElement, local: string): string | undefined {
  for (const [k, v] of el.attrs) if (localOf(k) === local) return v;
  return undefined;
}
