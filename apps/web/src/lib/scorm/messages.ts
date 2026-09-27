// SCORM words for people, from the "rtt" namespace (rtt.scorm.*), without
// depending on a request.
//
// Two users:
//   - format.ts's status words and durations, which a page renders with its
//     own translator and, when it passes none, in English;
//   - the reasons an upload is refused (rtt.scorm.upload.*). The validators
//     (package.ts, zip.ts, manifest.ts, xml.ts) are pure and run before
//     anything knows who is asking, so a refusal carries its message as a KEY
//     with values -- a ScormMessage -- plus the English sentence as its
//     `message` (logs, tests). ingest.ts, which answers the administrator,
//     writes it again in her language.

// Relative, not "@/": the behaviour suite imports the validators directly,
// without the app's path alias.
import en from "../../i18n/locales/en/rtt.json";

/** A translator for the "rtt" namespace, as getTranslations("rtt") returns. */
export type RttTranslate = (key: string, values?: Record<string, string | number>) => string;

/** A message of rtt.scorm.upload by key; a value may be another such message. */
export type ScormMessage = { key: string; values?: Record<string, string | number | ScormMessage> };

export const scormMessage = (key: string, values?: ScormMessage["values"]): ScormMessage => ({ key, values });

/**
 * The English bundle's rtt.<key>, its plain {name} arguments filled in. (These
 * messages use no plural or select, so no ICU formatter is needed.)
 */
export const englishRtt: RttTranslate = (key, values = {}) => {
  const message = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
  return String(message ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
};

/** `m` in the language of `t` (English when none is given). */
export function scormText(m: ScormMessage, t: RttTranslate = englishRtt): string {
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(m.values ?? {})) {
    values[name] = typeof value === "object" ? scormText(value, t) : value;
  }
  return t(`scorm.upload.${m.key}`, values);
}
