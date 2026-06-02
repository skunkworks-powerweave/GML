# Research 158

Four design choices, documented inline in the touched files and
expanded here.

## (1) Server-side ILIKE vs client-side instant filter

Two viable patterns for an inline name search on a 200-row index:

- **Server-side ILIKE via `?q=` URL param + native GET form.** WHERE
  clause runs in Postgres against the canonical index of 200 rows.
  No client-side state. The URL is shareable and bookmarkable. Every
  search is a full page render — fine at 200 rows over a fast link,
  noticeable but acceptable on a Ladakh 3G link (the dynamic="force-
  dynamic" pages already do a full SSR cycle on every navigation).
- **Client-side instant filter via React state + `useDeferredValue` /
  fetch debounce.** Each keystroke filters in-memory or re-fetches.
  No round-trip per keystroke, instant feedback. Requires a client
  component on every repo index page (we currently have zero), a new
  React state, and the URL is no longer the source of truth.

We chose the URL-driven GET form because:

- **Shareability is load-bearing.** A mentor narrowing to "all schools
  matching 'CHU' in Leh" wants to paste that URL to their lead. With
  in-memory state the URL doesn't include the search and the lead
  can't reproduce the view.
- **Zero new client components.** Each of the 7 repo index pages is a
  server component today. Introducing 7 client components for a search
  bar would balloon bundle size on the very pages that matter most for
  field-mentor low-bandwidth UX.
- **Auditability.** The URL carries the search state — a future spec
  that wants to log "which queries did users run" can read the URL
  query log without a new API endpoint.
- **Consistency with spec 129.** Every other filter on these pages
  (district, grade, status, kind, etc) is URL-driven. The search
  joins the family.

A future spec can layer a thin client-side debounce on top
(`<form onSubmit={..., new Promise.race}>` style) without changing the
URL contract.

## (2) Why ILIKE %q% and not pg_trgm / fuzzy

Three options for the actual narrowing query:

- **`ILIKE %q%`.** Substring match, case-insensitive. Sequential scan
  with a 200-row LIMIT (~9-60 rows for most repo indexes). No
  extension dependency. Misses typo tolerance.
- **`pg_trgm` GIST/GIN index + similarity search.** Typo-tolerant
  ("CHUA" matches "CHUSHOT"), needs the extension installed in the
  container image and a per-column index. Index build cost is real
  on a fresh tenant.
- **Full-text search via `tsvector` + GIN.** Heaviest. Designed for
  document search, overkill for one-name-column filtering.

We chose ILIKE because:

- The repo indexes are small (max ~200 rows post-filter). Sequential
  scan over a 200-row LIMIT is cheap enough that the planner doesn't
  even consider an index.
- pg_trgm requires a docker image change (the `postgres:16-alpine`
  image we ship doesn't include the extension by default) and a
  migration to install the per-column indexes. The migrations
  directory has 18 entries currently; adding a non-load-bearing
  fuzzy-search migration would be churn.
- The audit said "name-search input" — the explicit ask is substring
  search, not typo tolerance.

A future spec that ships pg_trgm globally (e.g. for cross-page Quick
Find ⌘K) can upgrade these ILIKE calls to similarity() with a single
helper swap.

## (3) Why escape `%`, `_`, and `\` in the user input

ILIKE treats `%` as "any string", `_` as "any single character", and
`\` as the escape prefix. A user searching for a school whose name is
literally `Government School 2_A` would otherwise get a wildcard
match — unlikely to bite today (none of the seeded names contain
those characters) but the escape is a 1-line defensive measure that
costs nothing.

The escape order matters: `\` must be escaped FIRST, otherwise the
`%` → `\%` substitution would itself be turned into `\\%` by the
later `\` → `\\` pass. The `escapeIlike` helper preserves this
ordering.

Drizzle's ILIKE operator passes the pattern through as a bind
parameter (no SQL injection risk), but bind parameters do NOT escape
pattern characters — the user input still gets interpreted as an
ILIKE pattern. The escape is doing real work.

We considered using Postgres' `LIKE ... ESCAPE '\\'` clause to make
the escape character explicit, but Drizzle's `ilike` builder doesn't
expose that option; the helper-level escape is the practical answer.

## (4) Why copy the helpers across 7 files vs extracting to lib/search.ts

Two patterns for the 5 lines that appear in each of the 7 pages:

- **Per-file copy.** Each page declares `SEARCH_Q_MAX = 200` and
  `escapeIlike(s)` at module scope. 7 copies of 5 lines = 35 lines of
  redundancy.
- **Shared `lib/search.ts` helper.** Single source of truth for the
  cap and escape. Each page imports.

We chose per-file copy because:

- **Governance test pinning.** The test asserts the literal `200`
  cap and `escapeIlike` shape per page. With a shared helper the test
  would have to import it and verify the shape once + verify each
  page imports it; that's more brittle than the literal string-pin.
- **Discoverability.** A reader of `schools/page.tsx` sees the cap
  inline. With a shared helper they'd have to follow an import to
  `lib/search.ts` and back.
- **Drift-resistance against future divergence.** If `/repo/sessions`
  later needs a higher cap (because session topics are longer than
  school names), splitting back out of a shared helper is a refactor;
  divergence in-place is a one-line bump.

The redundancy is small (5 lines × 7 = 35 lines) and the upside is
real. A future spec that grows the search to ~12 surfaces or adds
behaviour beyond cap + escape can promote to a shared helper.

## (5) Why no name search on /repo/students

SM-9 (spec 099) audits every render of `/repo/students` via
`recordAudit({ action: "learners.bulk_view", ... })`. The audit
captures `rowCount`, `page`, and `schoolFilter` so a compliance
review can reconstruct who saw which slice of PII.

A name search on /repo/students would mean every keystroke (after the
Search button click — but the user might click Search every other
letter) generates a new audit row. A typist clearing and re-entering
a name 3 times in 10 seconds would emit 6+ rows for what's
semantically one viewing session.

The fix would be either:

1. Per-session audit dedup (one row per learner-set seen per
   programme_admin per hour), OR
2. Per-query audit dedup (one row per `(rowCount, schoolFilter, q)`
   tuple per hour).

Both are out of scope here. The spec explicitly excludes
/repo/students; a follow-up spec can layer in the dedup if QA asks
for the feature.

## (6) Why the governance test pins literal strings

The 7 fixes are all "the code MUST contain X" contracts:

- The `ilike(<column>, ...)` predicate per page.
- The `<input type="search" name="q">` form control.
- The `aria-label` attribute (a11y contract).
- The `maxLength={SEARCH_Q_MAX}` attribute (the 200-char cap on the
  client side mirrored from the server side).
- The Clear link, gated on `qFilter`.

Each is a one-line pin in the test. A contributor can't silently
soften the 200-char cap, drop the escape helper, or remove the Clear
link without the governance test catching the diff.

The alternative — Playwright integration tests that actually type
into the input and verify the URL changes — would require booting
the full Next.js dev server, the database, and a browser. The
zero-runtime string-pin test runs in <100ms and is the practical
contract.
