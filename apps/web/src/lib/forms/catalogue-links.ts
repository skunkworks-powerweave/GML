// Where each row on /forms sends its user.
//
// A mentorship form is answered AGAINST A PAIRING -- submitFormAction refuses a
// submission without a pairingId -- so a catalogue row has to carry one. The
// page used to link one pairing to its form, an administrator to the bare form,
// and everybody else to "/inbox". "Everybody else" was every mentor with two or
// more mentees, which is the normal case (the shipped seed gives both mentors
// five), and /inbox has no feedback-form card, so every row dropped them on
// their notification feed with no form and no explanation.
//
// Now each row expands to one link per pairing, labelled with the other party's
// name, capped, with the overflow going to /mentorship -- whose pairing pages
// already carry working per-quarter form links. Nobody is sent to /inbox.
//
// Pure (no database, no server-only) so tests/behaviour can call it:
// tests/behaviour/form-catalogue-links.test.ts.

export type PairingChoice = {
  id: string;
  /** Who the form is about: the mentee's name for a mentor, the mentor's for a teacher. */
  label: string;
  active: boolean;
};

export type CatalogueLink = {
  href: string;
  label: string | null;
  /** Set on a per-pairing link, so the page can mark that pairing answered. */
  pairingId?: string;
};

/** How many per-pairing links a catalogue row renders before "All N pairings". */
export const MAX_PAIRING_LINKS = 6;

/** The pairing list, where each pairing page links its own quarter's forms. */
const PAIRING_LIST = "/mentorship";

/** The mentorship password prompt, returning to the catalogue once unlocked. */
export const UNLOCK_FORMS_HREF = `/gate/mentorship?next=${encodeURIComponent("/forms")}`;

/**
 * A /forms/[slug] path segment as Next hands it over -- still percent-encoded
 * -- turned back into the `${kind}-${audience}-${version}` it names. Without
 * this a version holding any character a URL encodes (the "endline-1+1" the
 * old version bump produced) could never match its own row. A malformed
 * escape is returned as-is, and simply matches nothing.
 */
export function decodeFormSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function formRunnerHref(slug: string, pairingId: string): string {
  return `/forms/${slug}?pairingId=${encodeURIComponent(pairingId)}`;
}

export function formCatalogueLinks(
  slug: string,
  opts: { isAdmin: boolean; pairings: readonly PairingChoice[]; lookupFailed?: boolean; locked?: boolean },
): CatalogueLink[] {
  // An administrator is party to no pairing; the bare form is a preview, and
  // the runner says plainly that it cannot be submitted without one.
  if (opts.isAdmin) return [{ href: `/forms/${slug}`, label: null }];

  // The mentorship section is locked. Who the caller's mentees are is exactly
  // what its password guards, so the page looks no pairing up and the one link
  // is the password prompt.
  if (opts.locked) return [{ href: UNLOCK_FORMS_HREF, label: "Enter the mentorship password to answer" }];

  // The lookup threw. Showing the forms is still the safer wrong answer; the
  // pairing list is a real choice, where the inbox was an unrelated feed.
  if (opts.lookupFailed) return [{ href: PAIRING_LIST, label: "Choose a mentorship pairing" }];

  // No pairing: nothing can be submitted, and the page says so in a banner.
  // No link rather than a link to a page that will refuse the answer.
  if (opts.pairings.length === 0) return [];

  if (opts.pairings.length === 1) {
    const only = opts.pairings[0]!;
    return [{ href: formRunnerHref(slug, only.id), label: only.label, pairingId: only.id }];
  }

  const shown: CatalogueLink[] = opts.pairings.slice(0, MAX_PAIRING_LINKS).map((p) => ({
    href: formRunnerHref(slug, p.id),
    label: p.active ? p.label : `${p.label} (not active)`,
    pairingId: p.id,
  }));
  if (opts.pairings.length > MAX_PAIRING_LINKS) {
    shown.push({ href: PAIRING_LIST, label: `All ${opts.pairings.length} pairings…` });
  }
  return shown;
}
