/**
 * Read the routing code out of a WhatsApp caption.
 *
 *   OBS-<code>  -> observation_cycle   (cycles carry codes like OBS-2026-009)
 *   TB-<uuid>   -> teach_back
 *   MM-<uuid>   -> mentor_meeting
 *   anything else -> generic
 *
 * ── WHY IT IS TOLERANT ───────────────────────────────────────────────────────
 *
 * This was `caption.match(/^(OBS|TB|MM)-([A-Za-z0-9._-]+)/)`: anchored at the
 * start, case-sensitive, and requiring the dash. A miss is not an error -- the
 * video still arrives, as 'generic' -- but 'generic' is visible only to admins
 * and the sender, so the cycle's observer and mentor never see it. Captions
 * that named the cycle perfectly well all missed:
 *
 *   "Obs-2026-009"                 a phone keyboard's auto-capitalisation
 *   "#OBS-2026-009"                what the app's own help text taught
 *   "OBS 2026-009"                 a space for the dash
 *   "OBS-2026-009."                a sentence; the stop was captured into the code
 *   "Lesson video OBS-2026-009"    the code not first
 *
 * The `.toUpperCase()` that followed the match showed case-insensitivity was
 * intended; the regex had no `i` flag, so it was dead code.
 *
 * Still conservative where it matters: the tag must stand on its own -- not be
 * the tail of a word ("Jobs-2026", "COMMIT").
 *
 * ── THE FIRST WELL-FORMED CODE WINS, NOT THE FIRST TAG ───────────────────────
 *
 * "mm" is millimetres, "tb" is Hinglish for "then", and "TB session" is a
 * phrase; all stand on their own. Taking the first tag read
 * "45 mm ruler work OBS-2026-009" as meeting "ruler" and lost the cycle. So
 * every tag is tried, and the first whose code has the right shape wins: an OBS
 * code starting with a digit (OBS-<year>-<NNN>), a UUID after TB or MM. Only
 * when none has, the first tag is returned as before, so a hand-entered code
 * ("OBS-PILOT-1") is still looked up and a malformed id is still reported as
 * one.
 *
 * Dashes are any of the dash family: phone keyboards substitute an en or em
 * dash for "--" and after a space. "OBS 2026 009" -- spaces for both dashes --
 * is read as 2026-009.
 *
 * ── BOTH FORMS OF THE CODE ───────────────────────────────────────────────────
 *
 * Returned bare ("2026-004") and full ("OBS-2026-004"), because the two sides of
 * the cycle lookup once disagreed on whether the prefix is part of it: the
 * observation branch compared the BARE code against a column holding the FULL
 * one, so every caption a teacher was told to write fell through to 'generic'.
 * The webhook matches either form, case-insensitively.
 */

export type CaptionContext = {
  type: "observation_cycle" | "teach_back" | "mentor_meeting" | "generic";
  /** The code after the tag, as typed ("2026-004"), trailing punctuation removed. */
  code?: string;
  /** Tag and code, the tag upper-cased ("OBS-2026-004"). */
  fullCode?: string;
};

/** Hyphen, non-breaking hyphen, figure/en/em dash, horizontal bar, minus, and their small and full-width forms. */
const DASHES = /[‐-―−﹘﹣－]/g;

/** A tag that is not the tail of a word. */
const TAG = /(?<![A-Za-z0-9])(OBS|TB|MM)/gi;

// After the tag: a separator -- a dash, spaces, an underscore or a colon
// ("OBS: 2026-009") -- then the code. With no separator the code must start
// with a digit, so "Observation" is not read as OBS + "ervation".
const CODE_AFTER_TAG = /^(?:[\s_:-]+|(?=\d))([A-Za-z0-9._-]+)/;

/** "OBS 2026 009": the rest of the code after a bare year, across a space. */
const NUMBER_AFTER_YEAR = /^[\s_:]+(\d{3,6})(?![A-Za-z0-9])/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TYPE_OF = { OBS: "observation_cycle", TB: "teach_back", MM: "mentor_meeting" } as const;

export function parseCaption(caption: string): CaptionContext {
  // One character for one, so positions do not move.
  const text = caption.replace(DASHES, "-");
  let first: CaptionContext | null = null;
  for (const t of text.matchAll(TAG)) {
    const tag = t[1]!.toUpperCase() as keyof typeof TYPE_OF;
    const after = text.slice(t.index + t[0].length);
    const m = CODE_AFTER_TAG.exec(after);
    if (!m) continue;
    // "OBS-2026-009." / "OBS-2026-009-" -- punctuation that ends a sentence or
    // a line is not part of any code the programme issues.
    let code = m[1]!.replace(/[._-]+$/, "");
    if (!code) continue;
    if (tag === "OBS" && /^\d{4}$/.test(code)) {
      const n = NUMBER_AFTER_YEAR.exec(after.slice(m[0].length));
      if (n) code = `${code}-${n[1]}`;
    }
    const ctx: CaptionContext = { type: TYPE_OF[tag], code, fullCode: `${tag}-${code}` };
    if (tag === "OBS" ? /^\d/.test(code) : UUID.test(code)) return ctx;
    first ??= ctx;
  }
  return first ?? { type: "generic" };
}
