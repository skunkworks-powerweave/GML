import "server-only";

// Shared translation helpers for the /repo pages (server components).
//
// Names, codes and titles from the database are shown as entered. What IS
// translated are the enum values the database stores and the pages display
// (a session's status, an outline's status, a resource's kind, a class's
// stage, a district): each maps to a label in the `repo` namespace, and a
// value no label exists for is shown as stored rather than as a raw key.

import { getLocale, getTranslations } from "next-intl/server";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";

export type RepoTranslator = Awaited<ReturnType<typeof getTranslations>>;

/** The Intl locale for dates in the viewer's interface language (en-IN, hi-IN, bo-IN). */
export async function repoIntlLocale(): Promise<string> {
  return INTL_LOCALE[normalizeLocale(await getLocale())];
}

/**
 * The key a stored enum value has under its group: lower-cased, a hyphen or
 * space followed by a letter camel-cased ("Lab-guide" → "labGuide"), an
 * underscore kept ("in_progress").
 */
function enumKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The label for a stored enum value, from `repo.<group>.<key>`; the value as
 * stored when the namespace has no label for it (a new status added to the
 * database before its translation).
 */
export function enumLabel(t: RepoTranslator, group: string, value: string): string {
  const key = `${group}.${enumKey(value)}`;
  return t.has(key) ? t(key) : value;
}

/**
 * A district's label: Leh and Kargil (stored as leh / kargil / kgl, as a code
 * or a name) have translated names; any other district shows as stored.
 */
export function districtLabel(t: RepoTranslator, value: string): string {
  const k = value.trim().toLowerCase();
  if (k === "leh") return t("district.leh");
  if (k === "kargil" || k === "kgl") return t("district.kargil");
  return value;
}

/**
 * The value of a yes/other ICU select ("{hasOwner, select, yes {…} other {}}"):
 * whether an optional part of a sentence is there.
 */
export function present(value: unknown): "yes" | "no" {
  return value ? "yes" : "no";
}
