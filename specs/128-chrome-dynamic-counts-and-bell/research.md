# Research 128

Four design choices documented inline in `chrome-counts.ts` and the
edited chrome components.

(1) **One loader per concern, all wrapped in `React.cache`.** We
considered a single mega-loader that returns `{nav, unread, queue}`
as one object, but `React.cache` works per-arglist — a single mega
loader keyed on `(userId, role)` would not reuse the unread count
across requests that share the same user but a different role
(impossible in this app, but the cache contract is per-arglist
identity). Three loaders keyed independently mean a descendant that
calls `loadUnreadNotifications(userId)` from a server component
deep in the tree reuses the layout's already-resolved value. The
overhead of three separate `cache` wrappers is negligible (each is
a `WeakMap` lookup at the React reconciler level).

(2) **The mentor pairings query joins through the `mentors` table.**
The prototype's "5 mentees" badge maps to active pairings owned by
*this user's* mentor row, not pairings created by this user. So the
loader first resolves `mentors.userId = session.user.id → mentor.id`
and then counts `mentor_pairings WHERE mentorId = ? AND status =
'active'`. Mentors without a `mentors` row (a brand-new account
seeded before the admin links them) get a 0 badge, no error.

(3) **Cycle-status filter sits on a tuple of three statuses.** The
observation_cycles status enum has five values: `nominated`,
`pre_submitted`, `observed`, `post_submitted`, `complete`. The
"in flight" set is the middle three — `nominated` rows are not yet
in motion, `complete` rows are finished. Using `inArray(...,
[...ACTIVE_CYCLE_STATUSES])` makes the predicate sargable on the
`observation_cycles_status_idx` composite index. The teacher branch
does NOT filter by `observation_cycles.teacherId` — that table's
`teacherId` references `teachers.id`, not `users.id`, and there is
no `teacher.userId` column on the current schema. For the chrome
badge we surface "cycles in flight globally" for teachers, matching
the prototype's behaviour (the per-user split would need a schema
hop that this run is not authorised to ship).

(4) **BullMQ `getJobCounts()` is the right primitive.** Alternatives
considered:
   - `queue.count()` returns one number (all states pooled) — loses
     the failed-vs-waiting distinction the topbar chip wants.
   - `queue.getJobs(['failed', 'waiting'], 0, -1)` returns the whole
     payload — wasteful when we just need lengths.
   - Custom Redis ZCARD calls — leaks the BullMQ key layout into the
     web app.
   `getJobCounts` takes a variadic list of state strings, performs
   one ZCARD per state, and pipelines them via a single Redis
   `MULTI` block. That's the same Redis round-trip cost as a single
   `queue.count()` call.

## Why the bell is a `<Link>`, not a server-action button

The bell only has one job: take the user to /inbox. A server-action
button would force a POST request through Next.js's action middleware
before the redirect; a `<Link>` is just a `<a>` element that the
client-side router intercepts for soft navigation. The unread count
chip is the badge value, not a click action — clicking the bell
itself is a navigation. No CSRF concern (Next.js' Link uses GET).

## Why the queue chip lives on desktop only

The mobile shell already has the bottom-tab dot for inbox unread and
the FAB for help. Adding a fourth chip ("queue") to a 360px-wide
header would crowd the brand label and the avatar circle. Operators
who care about queue depth are admin-tier users on desktop. We
preserve the mobile chrome's quietness and surface the indicator
where it matters.

## Why we hide queue chip when all counts are zero

Idle systems are the common case. A persistent "0 processing · 0
waiting · 0 failed" chip would train operators to ignore it. The
chip exists to draw attention to non-zero queue states — hiding it
when there's nothing to surface is the right default. The chip
reappears the moment any job is enqueued.

## Why `formatBellBadge` clamps at "99+"

The badge sits in a 16px-square circle to the top-right of the bell
icon. "100" requires three monospace digits, which would force the
circle to widen. "99+" reuses the same width as any 2-digit count
and signals "many" without claiming an exact number. Tracks how
GitHub, Linear, and Gmail handle the same trade-off.
