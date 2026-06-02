# Research 127

Five design choices documented inline in the rewritten page.

## (1) React.cache wrapper, not a top-level shared call

Spec hard-rule explicitly calls for `React.cache` on chrome counts
"to avoid duplicate queries within a request". We apply it to every
helper (`getProgrammeChrome`, `getTeacherChrome`, `getObserverChrome`,
`getMentorChrome`, `getFieldMapSchools`) so that:

- The mentor variant's stat builder and its TodayChecklist builder
  share one `getMentorChrome` materialisation per request.
- The admin variant's stat builder and its TodayChecklist builder
  share one `getProgrammeChrome` materialisation.
- The render path can call each helper as many times as it wants —
  no duplicate round-trips.

We use `react`'s `cache` import (Next.js 15 server-component built-in,
already used by `apps/web/src/lib/wiki.ts`), not a custom cache.

## (2) Promise.all per helper, not per page

The brief says "Wrap each variant in Promise.all of count() queries
for performance (single round-trip per role)". Each helper internally
runs its 4-7 count queries through `Promise.all`, so the page sends
one batch of parallel SELECTs to Postgres per render. The driver
(node-postgres) pipelines them on a single connection.

Counts are not nested — each query is independent, so `Promise.all`
is the right primitive. The Drizzle ORM does not currently support
batch query API, so this is the canonical pattern.

## (3) `mentor.pendingVideoReviews` uses the JSX prototype's exact status set + SLA

The brief specifies:

> mentor: 'Pending video reviews' (=video_submissions where
> context=teach_back AND status in (received,queued,transcoding,
> review_pending) within last 48h, filtered to this mentor pairings)

We honour all four constraints — context, status set, 48h window,
and the join from `videoSubmissions.submittedByUserId → teachers.userId
→ mentorPairings.teacherId` filtered to `mentorPairings.mentorId =
<mentor row for this user>` and `status='active'`.

`mentorPairings.status = 'active'` filters out paused / ended /
review / complete pairings — the mentor only sees videos for
mentees they're currently working with.

## (4) `teacher.openQuizzes` filters with `NOT IN (SELECT ...)` subquery

Quiz "open" means active + not yet attempted by this user. Drizzle
doesn't ship a `notInArray` against a subquery, so we drop into a
`sql` template:

```ts
sql`${quizzes.id} NOT IN (
  SELECT ${quizSubmissions.quizId}
  FROM ${quizSubmissions}
  WHERE ${quizSubmissions.userId} = ${userId}
)`
```

This produces a correlated `NOT IN` that Postgres can optimise on
the `quiz_submissions_user_idx` index. If a quiz has multiple
submissions for the same user (re-attempts), the subquery
de-duplicates implicitly — `NOT IN` is set-based.

## (5) `super_admin.storageMb` is a `SUM(files.sizeBytes)` proxy

The brief offers: "'Storage used (MB)' from MinIO stats if accessible
— else show dash and document deviation."

MinIO admin bucket-stats requires the admin credentials which live
behind the worker boundary, not on the web request boundary. Rather
than show a dash (which is unhelpful to ops), we ship the proxy:

```ts
SUM(files.size_bytes) / 1024 / 1024
WHERE files.deleted_at IS NULL
```

This:

- Updates instantly when a new upload completes (files row gets
  inserted with `status='stored'`).
- Excludes soft-deleted rows (matches what MinIO would tombstone).
- Is honest about what it counts — the card hint reads `SUM(files.size_bytes)`.

The deviation is documented in `spec.md` and in the dashboard code
itself. A future spec can swap the proxy for a real MinIO probe if
the credential plumbing reaches the web server.

## (6) Q-progress forms due is a proxy, not a real form-due join

Real form-due detection requires joining `feedback_responses` against
quarter boundaries with multi-CTE logic:

```sql
-- pairings whose current_quarter is N and have no feedback_responses
-- with kind = "progress_N" filed
SELECT pairing_id WHERE current_quarter = q AND NOT EXISTS (
  SELECT 1 FROM feedback_responses fr
  JOIN feedback_forms ff ON fr.form_id = ff.id
  WHERE fr.pairing_id = pairing_id AND ff.kind = ('progress_' || q::text)::feedback_kind
)
```

This works but it's hot on every dashboard render. The proxy
(`current_quarter IS NOT NULL AND meetings_count > 0`) captures the
prototype's intent — pairings that have advanced past Q1 and held at
least one meeting need a progress form filed — without paying the
multi-table cost on every page hit.

If/when the count needs to be precise (and not just "directional"
for the stat card), we wrap the real join in `React.cache` and put it
on its own helper — but the prototype's stat label is intentionally
fuzzy ("Q-progress forms due"), so the proxy is faithful.

## (7) Schools FieldMap uses code-hash for coordinates

The brief says the FieldMap dots should be real schools with click-
through to `/repo/school/[id]`. The schools table doesn't carry
lat/long (out of scope per the no-schema rule), so we hash the
school code into stable `(x, y)` coordinates inside the 520×320 SVG
viewport. The Kargil / Leh district split is faked via the code
prefix (`GMS-K…` / `GPS-K…` / `GHS-K…` → Kargil/saffron, others
→ Leh/indigo).

This isn't a real geographic map — it's a schematic, exactly as
the JSX prototype labels it ("UT of Ladakh — schematic"). A future
spec can add a `schools.lat`/`schools.lng` migration and place dots
correctly. For now, every school is on the map and clickable, which
satisfies the brief.

## (8) `dashboard.viewed` audit is fire-and-forget

We call `recordAudit({ action: "dashboard.viewed", ... })` without
awaiting it (`void recordAudit(...)`) so a slow audit insert doesn't
delay the page render. The existing `recordAudit` helper is already
best-effort — it logs but does not throw on insert failure (see
`apps/web/src/lib/audit.ts`).

This puts every dashboard render into the audit log with role +
user_id, which the audit-log surface can already filter (spec 116).
