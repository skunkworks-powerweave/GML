# Spec 121 — QuickFind ⌘K / Ctrl+K overlay (Workflow Run 10 frontend parity)

## Why

The JSX prototype's topbar carries a `Search teachers, schools, sessions…`
field with a `⌘K` chip (LMS GML Frontend/shell.jsx line 187), and the App
shell wires a global keyboard listener that toggles a cross-entity
search overlay (`WikiQuickFind`, app.jsx lines 21, 62-70, 275-288).
That overlay is a critical wayfinding affordance: it is the only way a
user holding two ids in their head (a school code and a teacher name,
say) reaches both pages without navigating through the sidebar.

Earlier execution dropped the feature on the floor — Run 9's
frontend-parity audit flagged it as a previously-dropped item. The
user has now explicitly asked for full prototype parity, so Run 10
revives it. Spec 121 is the closure entry.

## What we ship

1. **API** — `GET /api/quickfind?q=<term>` returns up to 20 cross-entity
   results as a flat array of `{ kind, id, label, sublabel, href }`
   rows. Auth-gated. Below `MIN_QUERY=2` chars the endpoint short-
   circuits to `[]` (still 200) so the client can poll while the user
   types without 400-spam. Every answered call writes a single audit row
   `quickfind.query` with `metadata { q, resultCount }`. That row is
   permanent (audit_log is append-only and nothing prunes it; SM-8's
   retention sweep covers notifications only), so the route bounds what
   it writes (F97, W3-26):
   - `q` longer than 240 characters (the widest column searched) →
     `400 { error: "query_too_long" }`, no search, no row;
   - more than 120 searches per user per minute → `429 { error:
     "rate_limited", retryAfterMs }` with `Retry-After`, no row;
   - the limiter unavailable → `503 { error: "rate_limit_unavailable" }`
     (fail closed), no row.

2. **Client overlay** — `apps/web/src/components/quickfind/QuickFind.tsx`,
   a `"use client"` component mounted globally in the authenticated
   layout. Listens for `Cmd+K` (mac) / `Ctrl+K` (Windows/Linux) at
   window scope, toggles a modal portal. The modal:
   - centers a search input + result list
   - debounces the fetch to `/api/quickfind` at ~180ms
   - supports `↑`/`↓` arrow keys and `Enter` to navigate the list
   - closes on `Esc`, on background click, and on result selection
   - shows the top 5 recently-viewed entities (localStorage, keyed by
     user id) when the search input is empty
   - says "No results" only for a search that was answered with none. A
     refused search says what happened instead: "Too many searches" with
     the seconds from `Retry-After` (429), "Signed out" (401), "Search too
     long" (400), "Search unavailable" (5xx, or a request that never
     reached the route)
   - renders nothing on the SSR pass (no portal target on the server)
     so it adds zero markup to first paint

3. **Layout wiring** — `apps/web/src/app/(authenticated)/layout.tsx`
   gains `<QuickFind userId={user.id} />` between `FTUXTour` and the
   shell. The mobile and desktop branches use the same wiring; the
   shortcut works on every authenticated route.

## Entities walked by the search

The fan-out covers exactly the entities the prototype's `wikiLookup`
table exposed, with one addition (`observation_cycles`, surfaced by
its code):

| kind                | search columns                                | href                       |
| ------------------- | --------------------------------------------- | -------------------------- |
| `teacher`           | `teachers.full_name`                          | `/repo/teacher/<id>`       |
| `school`            | `schools.name`, `schools.code`                | `/repo/school/<id>`        |
| `class`             | `'Grade '||grade`, `classes.class_teacher_name` | `/repo/class/<id>`        |
| `subject`           | `subjects.name`, `subjects.code`              | `/repo/subject/<id>`       |
| `observation_cycle` | `observation_cycles.code`                     | `/observation/<id>`        |
| `mentor_pairing`    | `mentors.name`, `teachers.full_name` (joined) | `/mentorship/<id>`         |
| `outline`           | `course_outlines.name`                        | `/repo/outline/<id>`       |
| `session`           | `sessions.topic` + `scheduled_date` (sublabel) | `/repo/session/<id>`      |

Each per-kind `LIMIT` is 4 (`MAX_PER_KIND`); the merged list is capped
at 20 (`HARD_CAP`) before the response is returned.

## What we do *not* do

- **No learner search.** Learners are explicitly excluded from the
  fan-out to satisfy SM-9. The prototype did not search learners
  either. If a future spec exposes them, the gate belongs on the API
  route (super_admin / programme_admin), never on the client. The
  spec body documents this so the audit trail is clean.
- **No fuzzy / trigram search.** ILIKE `%term%` on indexed columns is
  enough for the data volumes we will run at (single-region, ~150
  schools, ~2,000 teachers). pg_trgm + GIN can land in a later spec
  if the LIMIT 4 per-kind output starts feeling truncated.
- **No schema changes.** Every column referenced is already present.
  The audit table already accepts arbitrary dotted-action strings
  (spec 021), so `quickfind.query` slots in without a migration.

## Acceptance criteria

- `apps/web/src/app/api/quickfind/route.ts` exists, exports a `GET`
  handler gated by `auth()`, returns `{ ok, q, results: [...] }` with
  a flat array, and calls `recordAudit({ action: "quickfind.query", … })`
  on every hit.
- `apps/web/src/components/quickfind/QuickFind.tsx` is a
  `"use client"` component that attaches one `keydown` listener at
  mount and cleans it up on unmount.
- The component closes on `Esc`, background click, and result
  selection. The keyboard shortcut is `Cmd+K` on mac and `Ctrl+K`
  everywhere else.
- `(authenticated)/layout.tsx` imports `QuickFind` and renders it
  with `userId={user.id}` in both the desktop and mobile branches.
- All five spec-kit files exist under `specs/121-quick-find-cmdk/`.
- `tests/governance/test_121_quick_find_cmdk.test.mjs` passes with
  at least seven assertions covering the wiring above.

## Non-goals

- No standalone `/search` page. The overlay is the canonical surface.
- No history persistence to the server — recents live in
  `localStorage` and are best-effort.
- No analytics dashboard for popular queries; the audit rows are the
  raw signal, and a later spec can roll them up.
