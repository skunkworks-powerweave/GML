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
 * the tail of a word ("Jobs-2026", "COMMIT") -- and the first code wins.
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

// (start | a non-alphanumeric)  TAG  (separator | a digit straight after)  CODE
//
// The separator may be a dash, spaces, an underscore or a colon ("OBS: 2026-009").
// With no separator the code must start with a digit, so "Observation" is not
// read as OBS + "ervation".
const CAPTION_CODE = /(?:^|[^A-Za-z0-9])(OBS|TB|MM)(?:[\s_:-]+|(?=\d))([A-Za-z0-9._-]+)/i;

export function parseCaption(caption: string): CaptionContext {
  const m = caption.match(CAPTION_CODE);
  if (!m) return { type: "generic" };
  const tag = m[1]!.toUpperCase();
  // "OBS-2026-009." / "OBS-2026-009-" -- punctuation that ends a sentence or a
  // line is not part of any code the programme issues.
  const bare = m[2]!.replace(/[._-]+$/, "");
  if (!bare) return { type: "generic" };
  const full = `${tag}-${bare}`;
  if (tag === "OBS") return { type: "observation_cycle", code: bare, fullCode: full };
  if (tag === "TB") return { type: "teach_back", code: bare, fullCode: full };
  if (tag === "MM") return { type: "mentor_meeting", code: bare, fullCode: full };
  return { type: "generic" };
}
