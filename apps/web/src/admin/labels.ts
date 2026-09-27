// The admin grid's words, in the viewer's language.
//
// ── WHERE THEY ARE ───────────────────────────────────────────────────────────
//
// Nothing in ./entities is text. Each entity's words live in the translation
// bundles under adminData.entities.<slug> (apps/web/src/i18n/locales/<locale>/
// adminData.json), one set per language:
//
//   label               the table's title ("Classroom sessions")
//   columns.<key>       a grid column's header
//   fields.<field>      a form field's label, where it is not a column or is
//                       called something else in the form; otherwise the
//                       column's header is the label
//   help.<field>        one line of guidance under a form input
//   enum.<field>.<v>    what an enum value is called ("in progress")
//
// The definitions used to carry English labels, so the grid, its form, its
// filters and its CSV panel were English whatever language the user picked.
// The slug and the field names are the keys: one source for the words, and
// an entity added to the registry without them fails its render test (a
// missing message throws there) rather than showing a key to a user.
//
// Pure: no server-only import, so the client form can import its types and
// tests can call it with any translator.

import { enumOptions, unwrapShape } from "./zod-shape";
import type { AdminEntity, AdminMessage } from "./types";

/**
 * A translator over the adminData namespace: getTranslations("adminData") on
 * the server, or a test's. Values are ICU arguments.
 */
export type Translate = {
  (key: string, values?: Record<string, string | number | Date>): string;
  has(key: string): boolean;
};

type Named = { slug: string };

const base = (entity: Named) => `entities.${entity.slug}`;

/** The entity's title: "Classroom sessions". */
export function entityLabel(t: Translate, entity: Named): string {
  return t(`${base(entity)}.label`);
}

/** A grid column's header. */
export function columnLabel(t: Translate, entity: Named, key: string): string {
  return t(`${base(entity)}.columns.${key}`);
}

/** A form field's label: its own, else the header of the column it shows as. */
export function fieldLabel(t: Translate, entity: Named, field: string): string {
  const own = `${base(entity)}.fields.${field}`;
  return t.has(own) ? t(own) : columnLabel(t, entity, field);
}

/** The line of guidance under a form field, if it has one. */
export function fieldHelp(t: Translate, entity: Named, field: string): string | undefined {
  const key = `${base(entity)}.help.${field}`;
  return t.has(key) ? t(key) : undefined;
}

/**
 * What an enum value is called. Only a value among `known` -- the schema's or
 * the database's list -- is looked up: a stored value outside it (a varchar
 * written before its list was narrowed) is shown as itself, and nothing read
 * from a row is ever used as a message path.
 */
export function enumLabel(
  t: Translate,
  entity: Named,
  field: string,
  value: string,
  known: readonly string[],
): string {
  return known.includes(value) ? t(`${base(entity)}.enum.${field}.${value}`) : value.replace(/_/g, " ");
}

/** An AdminMessage (a rule's refusal) as a sentence. */
export function adminMessage(t: Translate, message: AdminMessage): string {
  return t(message.key, message.values);
}

/** The first of a rule's field problems as `field: message`, and each as a sentence. */
export function problemsText(
  t: Translate,
  problems: Record<string, AdminMessage>,
): { summary: string; fields: Record<string, string> } {
  const fields = Object.fromEntries(Object.entries(problems).map(([f, m]) => [f, adminMessage(t, m)]));
  const [field, message] = Object.entries(fields)[0]!;
  return { summary: t("fieldMessage", { field, message }), fields };
}

/**
 * The words RowForm (a client component) shows for an entity, resolved on the
 * server: each field's label and guidance, and each enum field's choices by
 * name. Passed as a prop, so a page does not ship every entity's words to
 * the browser.
 */
export type RowFormText = {
  fields: Record<string, { label: string; help?: string }>;
  /** field -> enum value -> what it is called. */
  choices: Record<string, Record<string, string>>;
};

export function rowFormText(t: Translate, entity: AdminEntity): RowFormText {
  const shape = unwrapShape(entity.formSchema);
  const fields: RowFormText["fields"] = {};
  const choices: RowFormText["choices"] = {};
  for (const field of entity.formFields) {
    const help = fieldHelp(t, entity, field);
    fields[field] = help ? { label: fieldLabel(t, entity, field), help } : { label: fieldLabel(t, entity, field) };
    const values = enumOptions(shape[field]);
    if (values) {
      choices[field] = Object.fromEntries(values.map((v) => [v, enumLabel(t, entity, field, v, values)]));
    }
  }
  return { fields, choices };
}
