# Quickstart 056

`import { wikiLookup, RelLink, hrefForEntity } from "@/lib/wiki"` in any repo route → `const teacher = await wikiLookup.teacher(id)` → render `<RelLink kind="teacher" id={teacher.id} label={teacher.fullName} />` — matches the JSX prototype's chip-link visually 1:1.
