# Spec 119 — Repo & RTT download/click wiring (Workflow Run 9 Tier H)

## Why

The frontend-parity audit surfaced 89 places where the JSX prototype
declares an interactive affordance but the live Next.js port renders
either a plain `<a>` with no `href` or a `<button>` with no handler.
Most of these are aesthetic, but six of them block actual user
workflows: the moment a user clicks a button and nothing happens, the
trust contract with the product breaks. Tier H of Run 9 closes the
six highest-impact workflow-blocker variants concentrated on the
`/repo/resource/[id]` detail page and the `/rtt/subject/[id]`
drill-in. None of them are large changes — each is a `<Link>`
wrapper, a small JSX block, or both — but together they take six
"this button does nothing" defects off the audit list.

## The six gaps closed

1. **/repo/resource/[id] header CTA copy.** The JSX prototype labels
   the primary button "Download PDF" (repository.jsx line 1028).
   Spec 087 already routed the live page to "View PDF" at
   `/repo/resource/<id>/view` because anti-download is part of the
   SM-4 deterrence contract — we don't want any path in the product
   advertising a download. Spec 119 ratifies the renamed CTA with an
   explicit code comment that ties it back to the SM-4 contract, so
   a future drive-by edit can't quietly regress it.

2. **/rtt/subject/[id] "Resume" CTA in the header.** The JSX has a
   primary "Resume" button (rtt.jsx line 154) with no handler. The
   live page had no such button at all. Spec 119 adds it as a
   `<Link>` to the first module by sequence, using an in-page
   anchor (`#module-<seq>`). When no modules exist the link falls
   back to `#modules` so the affordance still lands the user
   somewhere meaningful instead of a dead button.

3. **/rtt/subject/[id] sessions table — clickable rows.** The JSX
   marks each session row as `cursor: pointer` (rtt.jsx lines
   206-212) but the live port renders inert `<tr>` rows. Spec 119
   wraps the Date and Session cells in `<Link href="/repo/session/<id>">`
   so the row content navigates to the classroom-session detail
   page on click. The link will 404 if the rtt-session id doesn't
   correspond to a classroom-sessions row (the two tables are
   distinct — `rtt_sessions` vs `sessions`); that mismatch is a
   data-modelling question for a future spec, not a UI defect to
   suppress now.

4. **/rtt/subject/[id] sessions table — Join / Watch action.** The
   JSX renders a `<a>Join</a>` / `<a>Watch</a>` link per row
   (rtt.jsx lines 211-212) with no `href`. Spec 119 adds an action
   column with a `<Link>` button labelled "Join" for upcoming
   sessions (scheduledAt is null or in the future) and "Watch" for
   past ones, both routing to `/repo/session/<id>`. We don't have a
   dedicated `/sessions/<id>/join` URL today; if one ships later,
   only this one component needs to update.

5. **/rtt/subject/[id] readings — PDF view button.** The JSX renders
   a `<button>` with a download icon per reading (rtt.jsx line 230)
   and no handler. The live port already wires `r.externalUrl` to
   an "Open" link in a new tab. Spec 119 covers the file-key-only
   case: when a reading has `fileKey` set but no `externalUrl`,
   render a "View" `<Link>` to `/repo/resource/<reading.id>/view`
   (the spec 087 in-browser viewer route). The route 404s if the
   reading id doesn't correspond to a `resources` row, which is
   expected today — `rtt_readings` and `resources` are not yet
   joined — but the link is in place for when they are.

6. **/rtt/subject/[id] Assessment card.** The JSX has a third
   right-column card with Start / Locked CTAs (rtt.jsx lines
   236-251). The live port had no Assessment card at all. Spec 119
   adds it with two rows: "Mid-unit check" with a Start `<Link>` to
   `/quizzes/mid-unit?subjectId=<id>` and "Endline assessment" with
   a Locked chip `<Link>` to `/quizzes/endline?subjectId=<id>`. The
   `/quizzes/*` route ships in Run 10's quiz-full-stack spec; until
   then these links intentionally 404. Rendering them now means the
   page is structurally complete and the quiz-stack spec doesn't
   have to re-touch this file.

## What we do *not* do

- **No new schema columns.** All six fixes are link wiring. The
  rtt-readings → resources join, the rtt-sessions → sessions join,
  and the `subjects.slug` column the quiz-stack will eventually want
  are deferred to their respective specs. Calling them out here so
  the audit trail is clean: those are intentional non-goals of
  Tier H.

- **No quiz route.** Spec 119 emits the link, not the route.
  Clicking the Start button today renders Next.js's stock 404 page.
  That is the explicit instruction from the orchestrator brief.

- **No download URLs.** The "Download PDF" framing is misleading
  given the SM-4 deterrence stack. Every reading-material path
  routes through the in-browser viewer or the external-URL pop-out;
  no path in this spec creates a `Content-Disposition: attachment`
  header or a `download` attribute.

## Acceptance criteria

- `apps/web/src/app/(authenticated)/repo/resource/[id]/page.tsx`
  still renders the "View PDF" CTA from spec 087 and is annotated
  with a spec 119 comment tying it to the SM-4 contract.
- `apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx`
  renders:
  - A header-level "Resume" `<Link>` whose href is one of
    `/rtt/subject/<id>#module-<seq>` or `/rtt/subject/<id>#modules`.
  - `id="module-<seq>"` anchors on each rendered module row.
  - Clickable session rows whose `<Link>` href is
    `/repo/session/<session.id>`.
  - A Join/Watch action column on each session row.
  - A "View" `<Link>` to `/repo/resource/<reading.id>/view` for
    readings with `fileKey` but no `externalUrl`.
  - An Assessment card with Start (`/quizzes/mid-unit?subjectId=…`)
    and Locked (`/quizzes/endline?subjectId=…`) `<Link>`s.
- All five standard spec-kit files exist under
  `specs/119-repo-rtt-download-and-clicks/`.
- `tests/governance/test_119_repo_rtt_download_and_clicks.test.mjs`
  passes with at least six assertions covering the above.

## Non-goals

- No client components — every change above is a server-component
  `<Link>` and stays inside the existing route's server boundary.
- No API routes, no server actions, no audit calls. Those land
  when the underlying features (quiz runner, session-join, etc.)
  ship.
- No styling refactors. The existing CSS tokens (`var(--ink-2)`,
  `btn`, `btn-sm`, `chip`) are reused as-is.
