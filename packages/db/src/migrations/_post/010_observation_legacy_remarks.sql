-- 010 — mark the observation notes written before authors were recorded.
--
-- WHY
--
-- The cycle page used to print observation_cycles.remark whole. This release
-- splits it on blank lines and renders each block that starts with
-- "[stamp UTC] author (role): " as that author's entry
-- (apps/web/src/lib/observation/notes.ts). That is safe for what
-- addNoteAction writes now, since formatNoteEntry drops blank lines from a
-- note, but not for the remarks already here: the previous addNoteAction
-- stored "[stamp UTC] note" with the note's own blank lines kept, and before
-- it the column was overwritten with free text. Read by the new parser, a
-- legacy note holding a blank line and a header-shaped line became an entry
-- attributed to whoever that line named; "Discussed with Head of Dept
-- (mentor): ..." became an entry by "Discussed with Head of Dept"; a note in
-- paragraphs became several undated entries. The parser cannot tell these
-- blocks from new ones (a forged header can carry any stamp), so the data is
-- marked instead, once, before the new code reads it.
--
-- WHAT
--
-- Each non-blank remark becomes ONE block: a first line that matches no
-- header, so the page shows it as an unattributed "Earlier note", then every
-- legacy line verbatim, stamps included, with only the blank lines between
-- them removed (and CRLF made LF, as the parser reads it). Nothing is lost. A
-- note appended afterwards is separated by a blank line and parses as its own
-- entry, as before.
--
-- Every existing remark is legacy: nothing before this release wrote the
-- structured format.
--
-- Not reversible (the blank lines are gone), which loses no text. Idempotent:
-- the lane is ledgered, and the marker guard makes a replay a no-op.
--
-- The table is unqualified on purpose: tests/behaviour/
-- observation-legacy-remarks.test.ts runs this file against a temporary copy
-- of it, which only an unqualified name resolves to.

UPDATE observation_cycles
   SET remark = 'Earlier notes (before authors were recorded):' || E'\n' ||
       regexp_replace(
         regexp_replace(btrim(remark, E' \t\r\n'), E'\r\n?', E'\n', 'g'),
         E'\n([ \t]*\n)+', E'\n', 'g')
 WHERE remark IS NOT NULL
   AND btrim(remark, E' \t\r\n') <> ''
   AND remark NOT LIKE 'Earlier notes (before authors were recorded):%';
