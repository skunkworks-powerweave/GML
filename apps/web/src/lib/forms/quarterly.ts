// Which feedback forms belong to a pairing's QUARTERS, and what each is called.
//
// feedback_kind has four values -- baseline, progress_1, progress_2, final --
// one per quarter. Two forms that are not quarterly borrow them anyway:
// seed_forms_misc.ts stores the School visit checklist as kind 'baseline'
// (mentor) and the Endline survey as kind 'final' (mentee), and tells them
// apart only by `schema.purpose`. Everything that maps a quarter to a form has
// to ignore those two, or:
//   - the pairing page's quarter strip, which built a kind -> version Map over
//     unordered rows, opened whichever came back last -- on the seeded database
//     the mentor's Q1 opened the School visit checklist and the mentor baseline
//     was unreachable from the pairing;
//   - submitting a school-visit checklist, a repeatable field-visit form,
//     closed Q1.
//
// Pure, so tests/behaviour can execute it.

export type FormKind = "baseline" | "progress_1" | "progress_2" | "final";

/** Quarter number (1..4) -> the kind of form that quarter is answered with. */
export const QUARTER_TO_KIND: Record<number, FormKind> = {
  1: "baseline",
  2: "progress_1",
  3: "progress_2",
  4: "final",
};

/**
 * The quarter a pairing moves INTO once a quarter's form is in.
 *
 * `final` is absent deliberately: it closes the pairing rather than opening a
 * quarter, and completePairingAction owns that transition.
 */
export const QUARTER_AFTER: Record<string, number | undefined> = {
  baseline: 2,
  progress_1: 3,
  progress_2: 4,
};

// What each kind is CALLED ("Baseline", "Progress check 1", ...) is in the
// translation bundles, not here: mentorship.formKind and mentorship.formTitle
// select on the kind, so a page resolves the name in its reader's language.
// This used to be an English KIND_LABELS map.

/** schema.purpose, or null for a quarterly form (which carries none). */
export function formPurpose(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const p = (schema as { purpose?: unknown }).purpose;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** A form that answers a quarter: one with no `purpose` of its own. */
export function isQuarterlyForm(schema: unknown): boolean {
  return formPurpose(schema) === null;
}

/**
 * Version order: "10" after "9", "2" after "1", letters after digits. Used to
 * pick ONE form deterministically when several active forms share a kind and
 * audience -- which happens the moment an administrator publishes a new
 * version and leaves the old one active.
 */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/**
 * kind -> the version of the active quarterly form to open for it. Forms with
 * a purpose are skipped; among several quarterly forms of one kind the highest
 * version wins, whatever order the rows arrived in.
 */
export function quarterlyVersionByKind(
  forms: ReadonlyArray<{ kind: string; version: string; purpose: string | null }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of forms) {
    if (f.purpose) continue;
    const current = out.get(f.kind);
    if (current === undefined || compareVersions(f.version, current) > 0) out.set(f.kind, f.version);
  }
  return out;
}

/**
 * The form's own title (schema.title, data an administrator loaded), or null
 * when it has none. A form may also carry its Hindi title (titleHindi, as the
 * seeds write it, or hindiTitle, as FormRenderer's type names it); a Hindi
 * reader gets that one.
 */
export function ownFormTitle(schema: unknown, locale?: string): string | null {
  const s = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v : null);
  if (locale === "hi") {
    const hindi = text(s.titleHindi) ?? text(s.hindiTitle);
    if (hindi) return hindi;
  }
  return text(s.title);
}

/** A translator over the mentorship namespace (getTranslations("mentorship")). */
export type FormTitleTranslator = (key: string, values: Record<string, string>) => string;

/**
 * What to call a form: its own title, or a readable name built from its kind
 * and audience -- "Baseline — Mentor", in the reader's language
 * (mentorship.formTitle). The fallback used to be
 * `${kind.replace("_", " ")} · ${audience}` -- "baseline · mentor" -- and the
 * /forms catalogue labelled rows by kind only, so the School visit checklist
 * and the mentor baseline were both "Baseline for mentors".
 */
export function formTitle(schema: unknown, kind: string, audience: string, t: FormTitleTranslator, locale?: string): string {
  return ownFormTitle(schema, locale) ?? t("formTitle", { kind, audience });
}
