// A zod validation problem, in the viewer's language.
//
// The grid's form and the CSV import show zod's messages to the operator:
// "Required", "Invalid uuid", "String must contain at least 2 character(s)".
// zod writes them in English, so they were English whatever language the
// user picked. This turns each issue zod reports into a message from the
// adminData bundle:
//
//   - an entity's own message (`.refine(..., { message })`, `.regex(re, msg)`)
//     is a key under adminData.validation, written as the key in the
//     definition (entities/*.ts);
//   - zod's defaults are recognised by comparing with zod's own English, and
//     the common ones rebuilt from the issue's details (zod.* keys), so the
//     English reads exactly as zod's did;
//   - anything else is shown as zod wrote it.

import { defaultErrorMap, type ZodIssue } from "zod";
import type { Translate } from "./labels";

/** zod's own English for `issue`, to tell its defaults from an entity's message. */
function zodDefault(issue: ZodIssue): string {
  return defaultErrorMap(issue, { defaultError: "", data: undefined }).message;
}

type Bound = { type: string; exact?: boolean; inclusive: boolean };

/** exact / inclusive / neither, for the select in zod.tooSmall.* and zod.tooBig.*. */
const mode = (issue: Bound) => (issue.exact ? "exact" : issue.inclusive ? "inclusive" : "other");

/** zod's English for its common defaults, rebuilt in the viewer's language; null if not one of them. */
function translatedDefault(t: Translate, issue: ZodIssue): string | null {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined"
        ? t("zod.required")
        : t("zod.invalidType", { expected: issue.expected, received: issue.received });
    case "invalid_date":
      return t("zod.invalidDate");
    case "custom":
    case "invalid_union":
      return t("zod.invalidInput");
    case "invalid_enum_value":
      return t("zod.invalidEnum", {
        options: issue.options.map((o) => (typeof o === "string" ? `'${o}'` : String(o))).join(" | "),
        received: String(issue.received),
      });
    case "invalid_string": {
      const v = issue.validation;
      return typeof v === "string" && ["uuid", "url", "email", "date", "datetime", "regex"].includes(v)
        ? t(`zod.invalidString.${v}`)
        : null;
    }
    case "too_small":
      // Strings, not numbers: zod printed 5000, and a formatted argument
      // would print 5,000.
      return ["string", "number", "array"].includes(issue.type)
        ? t(`zod.tooSmall.${issue.type}`, { mode: mode(issue), minimum: String(issue.minimum) })
        : null;
    case "too_big":
      return ["string", "number", "array"].includes(issue.type)
        ? t(`zod.tooBig.${issue.type}`, { mode: mode(issue), maximum: String(issue.maximum) })
        : null;
    default:
      return null;
  }
}

/** One zod issue as the operator should read it. */
export function issueMessage(t: Translate, issue: ZodIssue): string {
  const own = issue.message;
  if (own !== zodDefault(issue)) {
    // An entity's message: a key under adminData.validation.
    return own.startsWith("validation.") && t.has(own) ? t(own) : own;
  }
  return translatedDefault(t, issue) ?? own;
}

/** `field: message` for an issue, as the form's summary and the importer's row report say it. */
export function issueLine(t: Translate, issue: ZodIssue): string {
  return t("fieldMessage", { field: issue.path.join("."), message: issueMessage(t, issue) });
}
