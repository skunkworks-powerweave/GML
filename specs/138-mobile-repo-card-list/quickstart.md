# Quickstart 138 — Mobile repo card-list

Manual smoke (5 minutes; needs a phone or browser devtools at 375px).

1. Boot the stack: `pnpm dev`. The seed (spec 086) provides 10 schools,
   60 teachers, 9 subjects, 30+ sessions, 25+ resources.

2. Sign in as a `mentor`. Open `/repo/schools` on a desktop browser. The
   8-column table renders as before — code, name, zone, district chip,
   teacher/class/session counts, chevron.

3. Open Chrome DevTools, toggle device toolbar (Cmd-Shift-M), pick
   "iPhone 12 Pro" (390px). Reload. The same `/repo/schools` URL now
   renders a stack of cards instead of the table:
   - Each card has a serif school name (16px), a "Code", "Zone", and
     count line beneath.
   - The district chip (Leh / Kargil) lands top-right.
   - Tapping anywhere on the card opens `/repo/school/<id>`.

4. Switch the district filter chip at the top from "All" to "Leh". The
   URL becomes `/repo/schools?district=leh` and only Leh schools show
   in the card stack — same filter contract as desktop (spec 129).

5. Repeat for the other six pages — every URL renders cards on mobile
   and the original table on desktop:
   - `/repo/teachers` — teacher name + Hindi name (var(--deva)),
     subject chip top-right, school code + phase + sessions stats.
   - `/repo/mentors` — mentor name + Hindi, base location chip
     (Leh-indigo / Kargil-saffron), expertise + mentee count.
   - `/repo/subjects` — subject name, subject code chip top-right,
     grades + outlines/sessions/readings stats.
   - `/repo/sessions` — session topic, status chip top-right,
     scheduled date/time mono, subject/grade/school line, teacher.
   - `/repo/resources` — resource title, kind chip top-right,
     subjects list, owner + pages, updated date mono.
   - `/repo/outlines` — outline name + owner Hindi, status chip
     top-right, subject, grade/term/sessions stats, owner name.

6. On each page, tap any card → the corresponding `/repo/<entity>/<id>`
   page opens (existing detail pages from spec 047-053). The
   back-button (browser-native) returns to the filtered list.

7. Toggle the device toolbar off (Cmd-Shift-M again). The same URL
   instantly switches back to the desktop table layout on the next
   navigation — the `gml-device` cookie flip from the client effect
   (spec 023) drives the SSR fork.

8. Open `/repo` (the repo home) — still renders the tile grid as
   before. This page is mobile-friendly by design (4×2 tiles) and
   was not part of this spec.

9. Sign in as a `super_admin` and confirm `/repo/schools.csv`
   (the export link) still works on mobile — the filter card's CSV
   button is unchanged.

## Edge cases worth checking

- A teacher with no Hindi name (seed: ~5 of 60) — the Devanagari line
  is omitted (no orphan whitespace).
- A school with zero classes / zero sessions — the secondary count
  line still renders as "0 teachers · 0 classes · 0 sessions".
- A subject with NULL grades_min / grades_max — the secondary line
  shows "All grades" instead of the "Grades 1–10" form.
- Switching from a filter with results to one with none (`?district=
  kgl` if you happen to seed only Leh) — the empty state shows the
  dashed-border "No schools match this filter." card.

## Why nothing visually changes on desktop

The fork is `device === "mobile" ? <Cards/> : <Table/>`. On desktop
the mobile branch returns null and the existing `<div className="card
">` desktop wrapper renders normally. No CSS overrides, no z-index
games, no scroll quirks. If you spot a desktop layout regression,
it's almost certainly from a different spec.
