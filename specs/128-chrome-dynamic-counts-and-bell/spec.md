# Spec 128 — Chrome dynamic counts and bell — Workflow Run 11 frontend-parity

## Why

The chrome that frames every authenticated page in the LMS — sidebar,
topbar, mobile bottom tabs — still carries three fake data points
imported wholesale from the JSX prototype:

1. **Sidebar nav count badges.** `NAV_BY_ROLE` (config/nav.ts) declares
   `count: 5` on "My mentees", `count: 6` on "Observation cycles",
   `count: 3` on "Pending review", and `count: 2` on a teacher's
   observations. These are seed numbers from the prototype — no row
   in any of the live tables drives them.
2. **Topbar bell.** Rendered as a `<button>` with the chat icon and
   no badge at all. The prototype showed a hardcoded "3"; the live
   chrome shows nothing. The bell is decoration: it has no click
   handler and the bell label doesn't surface unread notifications.
3. **2G/queue indicator.** The prototype's bottom-left status pill
   said "Online · synced" (cosmetic) but the JSX also referred to a
   `Queue · N items` chip in early drafts. Neither was wired; the
   indicator is purely decorative and never reflects what the
   transcode worker is actually doing.

Spec 128 wires all three to real backend data. The schema is
unchanged (all four count-bearing tables already exist), so this is
a pure data-wiring run.

## What this spec does

1. Adds `apps/web/src/lib/chrome-counts.ts`, a tiny server-only data
   layer with three `React.cache`-wrapped loaders:
   - `loadNavCounts(userId, role)` — per-role count package.
     For `mentor` we run four counts: active pairings owned by this
     mentor, observation cycles in flight (pre_submitted /
     observed / post_submitted), videos `review_pending` (last
     30 d), form drafts owned by this user. For `observer` we run
     cycles assigned to this observer plus drafts. For `teacher`
     we run cycles, recent uploads, drafts. Admin roles only run
     drafts (no badge-bearing nav rows).
   - `loadUnreadNotifications(userId)` — single COUNT(*) from
     notifications WHERE user_id = :user AND read_at IS NULL.
   - `loadQueueDepth()` — `transcodeQueue.getJobCounts(waiting,
     active, failed)` from `@gml/worker/queues`.
2. Edits `(authenticated)/layout.tsx` to call all three loaders in
   parallel and forward the results into the shell.
3. Updates `Sidebar.tsx` and `BottomTabs.tsx` to take a `counts`
   prop and merge it into `NAV_BY_ROLE` via `applyNavCounts` (a
   small id→resolver map keyed on `mentorship`, `observation`,
   `videos`, `uploads`, `forms`).
4. Updates `Topbar.tsx` to render the bell as a `<Link
   href="/inbox">` with the unread chip ("99+" past 99) and a new
   queue-depth chip (`{N processing · K waiting · M failed}`) that
   hides when all three are zero.
5. Adds `apps/web/src/app/api/notifications/unread-count/route.ts`
   — a one-line GET handler returning `{ count }` so a future
   client-side polling island can refresh the chip without a full
   layout rerender.

## What this spec does NOT do

- **No schema additions.** All four queries hit existing tables and
  columns (mentor_pairings, observation_cycles, video_submissions,
  notifications, form_drafts).
- **No client-side polling island.** The endpoint exists for future
  use; the chrome itself is rendered server-side on every request
  (the layout is `force-dynamic` via dashboard's existing flag).
- **No dependency additions.** `react`'s `cache()` ships with React;
  `bullmq`'s `Queue.getJobCounts()` is already exported by
  `@gml/worker/queues`.
- **No translation of count chips.** The bell badge ("99+") and the
  queue label ("N processing") stay English; the topbar's other
  labels (sign-out, language picker) already translate via
  spec 125.

## Fallback strategy

Every loader is wrapped in a try/catch that logs to `console.error`
and returns the zero shape (`{}`, `0`, `{active:0, waiting:0,
failed:0}`). If Postgres is down, the chrome still renders without
chips. If Redis is down, the queue chip stays hidden.

## Performance budget

The layout adds three loaders to the per-request fan-out:
- `loadNavCounts`: at most four COUNT(*) statements wrapped in a
  `Promise.all`. ≤ 50 ms cold path against an indexed DB.
- `loadUnreadNotifications`: single COUNT(*) with the
  `notifications_user_unread_idx` partial index. < 5 ms.
- `loadQueueDepth`: one Redis `MULTI` (BullMQ wraps it). < 10 ms.

Total added: < 70 ms cold, < 5 ms warm (Redis ZCARD is O(1); the
DB plan is index-only). `React.cache` ensures any descendant that
calls these loaders again reuses the same Promise.

## Acceptance criteria

- `apps/web/src/lib/chrome-counts.ts` exports `loadNavCounts`,
  `loadUnreadNotifications`, `loadQueueDepth`, `applyNavCounts`,
  `formatBellBadge`, `formatQueueLabel`, plus the `NavCounts` and
  `QueueDepth` types. Each loader is wrapped in `React.cache`.
- `apps/web/src/app/(authenticated)/layout.tsx` calls the three
  loaders in a single `Promise.all` and forwards `navCounts`,
  `unreadCount`, and `queueDepth` to the shells.
- `Sidebar.tsx` accepts a `counts?: NavCounts` prop and pipes it
  through `applyNavCounts` before rendering.
- `BottomTabs.tsx` accepts `counts?: NavCounts` and `unreadCount?:
  number`; the `observe`, `pairings`, and `inbox` mobile tabs grow
  a small badge dot when their respective counts are > 0.
- `Topbar.tsx` accepts `unreadCount?: number` and `queueDepth?:
  QueueDepth`; the bell renders as a `<Link href="/inbox">` with a
  `data-testid="topbar-bell"` attribute and a chip; the queue
  indicator chip has `data-testid="topbar-queue-indicator"` and is
  hidden when every count is zero.
- `apps/web/src/app/api/notifications/unread-count/route.ts` exists
  with a GET handler that returns `{ count }` and 401 when no
  session.
- Five spec-kit files exist at `specs/128-chrome-dynamic-counts-and-bell/`.
- `tests/governance/test_128_chrome_dynamic_counts_and_bell.test.mjs`
  passes with at least 8 assertions covering all of the above.
