import "server-only";

// What the teacher's CSV uploads (a session's attendance, her students) and
// downloads (the roster, the students template) share.
//
//   reading    one file field of a form, capped in size, then parsed with the
//              same PapaParse and the same formula-cell rule the admin import
//              uses (admin/data/[entity]/csv.ts, admin/csv-safety.ts): a BOM or
//              CRLF line ends and quoted commas are no trouble, and a cell the
//              admin export escaped (' before = + - @) is read as it was
//   shape      the columns are found by name, in any order and case ("Roll
//              number", "roll_number" and "rollNumber" are one column); a row
//              keeps its spreadsheet line, so a problem is reported where she
//              can find it
//   writing    Papa.unparse with the export's escaping, so a name that begins
//              with = + - @ cannot run in the spreadsheet she opens it in
//
// The column names are a data contract with spreadsheets and stay English in
// every language; what is said about a row is in her language (teaching.csv).

import Papa from "papaparse";
import type { getTranslations } from "next-intl/server";
import { CSV_EXPORT_OPTIONS, unescapeFormulaCell } from "@/admin/csv-safety";

export type Translate = Awaited<ReturnType<typeof getTranslations>>;

/**
 * A class list or a day's attendance is a few kilobytes; this is generous.
 * Next also refuses a server action's body past 1 MB, so a bigger cap here
 * would never be reached.
 */
export const CSV_MAX_BYTES = 512 * 1024;
/** Data rows (not counting the header): a whole school's roll, with room to spare. */
export const CSV_MAX_ROWS = 1000;
/** How many unimported rows are listed back; the rest are counted. */
export const CSV_MAX_ISSUES = 50;

export type CsvFailure = "noFile" | "tooBig" | "unreadable" | "empty" | "tooManyRows";

/** The words a failure is told in: teaching.csv.<failure>. */
export function failureText(t: Translate, failure: CsvFailure): string {
  return t(`csv.${failure}`, { max: failure === "tooBig" ? String(CSV_MAX_BYTES / 1024) : String(CSV_MAX_ROWS) });
}

/** The text of the file in the form's `field`, or why there is none. */
export async function readUpload(fd: FormData, field = "file"): Promise<{ text: string } | { failure: CsvFailure }> {
  const file = fd.get(field);
  if (!file || typeof file === "string" || file.size === 0) return { failure: "noFile" };
  if (file.size > CSV_MAX_BYTES) return { failure: "tooBig" };
  return { text: await file.text() };
}

/** A cell or a name as compared: Unicode-composed, spaces collapsed, case folded. */
export function fold(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A header as compared: "Roll number", "roll_number" and "rollNumber" are one. */
const headerKey = (h: string): string => h.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export type CsvRow = { line: number; cells: Record<string, string> };

export type ParsedCsv = {
  /** The columns the file has, by the names `columns` gave them. */
  present: ReadonlySet<string>;
  rows: CsvRow[];
};

/**
 * Parse a CSV the teacher uploaded. `columns` maps every header spelling that
 * is accepted (see headerKey: lower case, letters and digits only) to the
 * column it means; a header it does not know is ignored. Every cell is
 * un-escaped and trimmed. A blank line is skipped, and the line numbers still
 * count it.
 */
export function parseCsv(text: string, columns: Record<string, string>): ParsedCsv | { failure: CsvFailure } {
  // Papa strips a BOM itself; this one is for a file Excel saved twice.
  const parsed = Papa.parse<string[]>(text.replace(/^﻿+/, ""), { skipEmptyLines: false });
  // An unclosed quote swallows the rest of the file: nothing after it can be trusted.
  if (parsed.errors.some((e) => e.type === "Quotes")) return { failure: "unreadable" };

  const lines = parsed.data.map((cells, i) => ({ line: i + 1, cells }));
  const filled = lines.filter((l) => l.cells.some((c) => c.trim() !== ""));
  const header = filled[0];
  if (!header) return { failure: "empty" };

  const names = header.cells.map((h) => columns[headerKey(h)]);
  const rows = filled.slice(1).map(({ line, cells }): CsvRow => {
    const out: Record<string, string> = {};
    names.forEach((name, i) => {
      // The first column of a name wins, as the admin import's aliases do.
      if (name && !(name in out)) out[name] = unescapeFormulaCell(cells[i] ?? "").trim();
    });
    return { line, cells: out };
  });
  if (rows.length === 0) return { failure: "empty" };
  if (rows.length > CSV_MAX_ROWS) return { failure: "tooManyRows" };
  return { present: new Set(names.filter((n): n is string => !!n)), rows };
}

/** One line per row that was not imported, in her language, capped. */
export function issueLines(t: Translate, problems: ReadonlyArray<{ line: number; message: string }>): string[] {
  const sorted = [...problems].sort((a, b) => a.line - b.line);
  const lines = sorted.slice(0, CSV_MAX_ISSUES).map((p) => t("csv.line", { line: p.line, message: p.message }));
  if (sorted.length > CSV_MAX_ISSUES) lines.push(t("csv.moreIssues", { count: sorted.length - CSV_MAX_ISSUES }));
  return lines;
}

/**
 * A CSV as a download. `no-store`: it names children, so no cache keeps it.
 * Formula-looking cells are escaped exactly as the admin export does.
 */
export function csvDownload(filename: string, fields: string[], data: Array<Record<string, string>>): Response {
  return new Response(Papa.unparse({ fields, data }, CSV_EXPORT_OPTIONS), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
