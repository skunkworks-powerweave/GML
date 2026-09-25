// The field kinds a feedback-form renderer draws (FormRenderer and
// MobileFormRunner in apps/web), in ONE list.
//
// Two lists used to say this: lib/forms/schema.ts, which decides what
// PUT /api/admin/forms/[id] accepts, and seed_forms_misc.ts's canonical set,
// which decides whether a stored form is broken enough to "repair". They
// disagreed -- the route accepted "scale", which neither renderer draws (it
// fell back to a text box), and the seed did not -- so an administrator's
// edit the route had accepted counted as broken, and the next deploy
// overwrote it on an unanswered form. Both now read this file.

export const FORM_FIELD_KINDS = [
  "text",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "number",
  "date",
  "likert",
  "rating",
] as const;

export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

/** Kinds drawn as one control PER OPTION: with no options, nothing at all. */
export const OPTION_BEARING_FIELD_KINDS: ReadonlySet<FormFieldKind> = new Set<FormFieldKind>(["select", "radio", "checkbox"]);
