// Notes on an observation cycle: how an entry is written, and how the remark is
// read back entry by entry.
//
// observation_cycles.remark is one text column that addNoteAction appends to:
// entries separated by a blank line, each beginning
// "[YYYY-MM-DD HH:MM UTC] author (role): ". The page printed the column whole,
// pre-wrap, so a note whose body held a blank line followed by a line of that
// shape rendered exactly like a separate entry by someone else -- the author,
// which the header exists to show, was forgeable from inside the text.
//
// Two halves close it. A body can no longer contain the separator: blank lines
// in a note are dropped when it is written. And the page no longer prints the
// column: it splits it on the separator and renders each entry's author as
// markup of its own, so whatever a body says stays inside its author's entry.
//
// Remarks written before this format kept their blank lines, so the split
// would have trusted their header-shaped lines too. They were marked once, at
// deploy, as a single block that matches no header
// (packages/db/src/migrations/_post/010_observation_legacy_remarks.sql).
//
// No "server-only": tests/behaviour imports it.

const ROLES = "teacher|mentor|observer|programme_admin|super_admin";
const HEADER = new RegExp(`^\\[(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}) UTC\\] (.+?) \\((${ROLES})\\): ?([\\s\\S]*)$`);
// Entries appended before authors were recorded: "[stamp UTC] text".
const UNATTRIBUTED = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\] ?([\s\S]*)$/;
// What addNoteAction puts between entries.
const SEPARATOR = /\n[ \t]*\n/;

export type NoteEntry = {
  /** "YYYY-MM-DD HH:MM" (UTC), or null for text with no stamp. */
  at: string | null;
  /** Null for an entry written before authors were recorded. */
  author: string | null;
  role: string | null;
  body: string;
};

/**
 * One entry as addNoteAction appends it. Line breaks inside the note are kept;
 * blank lines are not, since a blank line is what separates entries.
 */
export function formatNoteEntry(at: Date, author: string, role: string, note: string): string {
  const stamp = at.toISOString().slice(0, 16).replace("T", " ");
  const who = author.replace(/\s+/g, " ").trim() || "Unknown user";
  const body = note
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
  return `[${stamp} UTC] ${who} (${role}): ${body}`;
}

/** The remark as entries, oldest first. Text that is not an entry is kept, unattributed. */
export function parseNotes(remark: string | null | undefined): NoteEntry[] {
  if (!remark) return [];
  return remark
    .replace(/\r\n?/g, "\n")
    .split(SEPARATOR)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const m = HEADER.exec(block);
      if (m) return { at: m[1]!, author: m[2]!, role: m[3]!, body: m[4]! };
      const u = UNATTRIBUTED.exec(block);
      if (u) return { at: u[1]!, author: null, role: null, body: u[2]! };
      return { at: null, author: null, role: null, body: block };
    });
}
