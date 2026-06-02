# Research 138

Five design choices behind the mobile repo card-list.

(1) **A new component instead of reusing `MobileEntityCardList` (spec 023).**
The admin card list hard-codes the `Export CSV` and `View row` buttons
because admin grids carry that contract by design (every entity has a
generic /api/admin/data/<slug>/export endpoint). Repo pages do not —
some have CSV exports, some don't, and the "view row" affordance is
the whole card already (tap-target). Trying to reuse the admin
primitive would require either a `hideButtons` prop or a forked
variant; both cost more than just writing a small, parametric repo
primitive. The two components do share the visual tokens
(var(--card-hi), var(--line), var(--r-3), 14px padding) so they read
as one design system.

(2) **Pure server component, no `"use client"` directive.**
The card is a `<Link>` (Next.js client-side router). Tap feedback
is browser-native (`:active` pseudo-class from globals.css, which
the existing `.m-row` rule covers). No state, no effects → keeps the
SSR pass cheap, no extra JS bundled, and the Drizzle data flows
straight through with zero serialization cost. If a future spec
needs a "swipe to dismiss" or "long-press menu" affordance, that's
the boundary at which a thin client wrapper could be introduced.

(3) **Device branch picks layout, not a media query.**
We follow the spec 023 pattern: `await getDeviceType()` from
`lib/device.ts` reads the `gml-device` cookie set by the client
effect on first visit, with a UA-regex fallback. Render the mobile
card branch when `device === "mobile"`, hide the desktop table via
`display: none` + `aria-hidden`. Why both branches in the DOM rather
than CSS-only? Because the *table layout* is heavy (8-9 cells × N
rows × inline styling) — keeping it off-screen-but-rendered on
mobile would bloat the HTML by ~3-5× per page, and a 360px phone on
a 3G link in Ladakh would feel that. Conditional render keeps SSR
HTML tight per device.

(4) **Caller-driven item shape, not a column registry.**
The admin card list takes a column registry (one source of truth
across desktop / mobile). The repo pages don't have that — each
table is bespoke (different joins, different aggregates, different
chip palettes). Forcing a registry here would mean either (a)
duplicating per-page mapping code anyway, or (b) introducing a
heavyweight repo-registry abstraction for one consumer. Neither
pays off. The chosen shape is a tiny prop contract: the page picks
{id, primary, hindi, secondary[], chip, href} per row inline. Each
adoption is a 20-30 LOC diff inside the existing page module.

(5) **Conditional render keeps the existing filter UI intact.**
Spec 129 (Workflow Run 11) ships URL-driven filters as `<form
method="GET">` or `<Link>` chips inside the filter card. Those
elements live *above* the table card on every page, so they're
unaffected by the table/card fork. A 360px mobile screen renders the
filter card with flex-wrap (already wired) — chips and selects stack
naturally. We deliberately do not introduce a mobile-specific
filter sheet because the existing one fits, and adding one would
double the filter UI surface area for marginal benefit.

## Why these seven pages and not others

The repo index pages that render `<table className="t">` with 7+
columns are:
- `/repo/schools` (8 columns: code, name, zone, district, teachers,
  classes, sessions, chevron)
- `/repo/teachers` (8 columns: name, Hindi, subject, school, phase,
  sessions, obs.cycles, chevron)
- `/repo/mentors` (5 columns: name, Hindi, expertise, base, mentees)
- `/repo/subjects` (6 columns: subject, grades, outlines, sessions,
  readings, chevron)
- `/repo/sessions` (9 columns: date, time, school, grade, subject,
  topic, teacher, status, action)
- `/repo/resources` (7 columns: title, kind, subjects, owner, pages,
  updated, chevron)
- `/repo/outlines` (9 columns: outline, subject, grade, term,
  sessions, weeks, owner, status, chevron)

All seven need the card-list treatment.

`/repo/students` is intentionally excluded: it's a PII-gated page
that the prototype itself flags as "Sample records — full database
restricted (PII)". The current desktop layout is already narrow
(few visible columns) and reads okay on mobile, so we don't touch
the privacy guard to avoid an unrelated change creeping in.

`/repo` (home) renders a tile grid, not a table — already mobile-OK.

Detail pages (`/repo/school/[id]`, `/repo/class/[id]`, etc.) are
already adapted by spec 027 (page-shell + chrome).

## Touch target floor

Cards in the JSX prototype's `MobRepoIndex` are ~62-68px tall
(38×38 emoji avatar + 14px padding + two text lines). Without the
avatar, a card with just a serif title and one secondary line clocks
in at ~48px — still above the 44px Apple HIG / Material floor. The
`minHeight: 44` declaration in `cardStyle` is a defensive belt:
short rows (e.g. a mentor without a chip and without expertise data
in seed) stay tappable.

## Why `display: none` instead of removing the desktop branch entirely

Keeping both branches in the source preserves a single render tree
for diffing in DevTools and gives QA a visual sanity-check on the
desktop side. The styling cost is zero (display: none is the
cheapest selector), and the SSR HTML cost is only one element with
`aria-hidden=true` on the wrapping `.card` — Postgres still issues
the same single query, and the inner table tbody render does
trigger but its DOM lives off-screen. Total HTML overhead on mobile:
~2-3 KB before gzip. Acceptable.

Alternative considered: render exactly one branch (`device === "mobile"
? <Cards/> : <Table/>`). Rejected because it spreads the conditional
into the wrapper `.card`, which carries the page's filter-card
styling neighbour and would either need duplication or a hoist. The
current shape (mobile branch first, desktop table after, both
unconditional) is the smaller diff per page.
