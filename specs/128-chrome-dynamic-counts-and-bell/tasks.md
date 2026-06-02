# Tasks 128

- [x] Read NAV_BY_ROLE, Sidebar, Topbar, BottomTabs to map the
      three hardcoded data points (mentee count, bell, queue
      indicator).
- [x] Confirm the four count-bearing tables exist: mentor_pairings,
      observation_cycles, video_submissions (status enum has
      'review_pending'), form_drafts, notifications. No schema
      additions.
- [x] Confirm `@gml/worker/queues` exports `transcodeQueue` and
      that `Queue.getJobCounts(...)` is available without booting
      a Worker.
- [x] Add `apps/web/src/lib/chrome-counts.ts`:
      - `loadNavCounts(userId, role)` — role-branched count
        package, ≤ 4 statements per role, wrapped in `cache(...)`,
        try/catch returns `{}` on failure.
      - `loadUnreadNotifications(userId)` — single COUNT(*)
        against `notifications` with the partial unread index.
      - `loadQueueDepth()` — `transcodeQueue.getJobCounts(
        'waiting', 'active', 'failed')`.
      - `applyNavCounts(sections, counts)` — merge live counts
        into NAV_BY_ROLE shape via an id→resolver map.
      - `formatBellBadge(n)` / `formatQueueLabel(depth)` helpers.
- [x] Add `apps/web/src/app/api/notifications/unread-count/route.ts`
      — GET handler returning `{ count }`, 401 on unauth, 405 on
      other verbs.
- [x] Wire `(authenticated)/layout.tsx`:
      - Import the three loaders.
      - `await Promise.all([loadNavCounts, loadUnread, loadQueue])`
        after the userPrefs read.
      - Forward `navCounts`, `unreadCount`, `queueDepth` into the
        chosen shell.
- [x] Extend `DesktopShell` + `MobileShell` props to accept these
      values and forward them.
- [x] Extend `Sidebar.tsx` props to take `counts?: NavCounts`; run
      `NAV_BY_ROLE[role]` through `applyNavCounts(counts)` before
      rendering.
- [x] Extend `BottomTabs.tsx` props to take `counts` +
      `unreadCount`; render small badge dots on `observe`,
      `pairings`, and `inbox` tabs.
- [x] Replace the topbar bell `<button>` with `<Link
      href="/inbox">` and add a `data-testid="topbar-bell"` /
      `data-testid="topbar-bell-badge"` pair. Render `99+` past
      99 via `formatBellBadge`.
- [x] Add the topbar queue indicator chip with
      `data-testid="topbar-queue-indicator"`; hide when all
      counts are zero.
- [x] Write five spec-kit files at
      `specs/128-chrome-dynamic-counts-and-bell/`.
- [x] Write
      `tests/governance/test_128_chrome_dynamic_counts_and_bell.test.mjs`
      with at least 8 assertions covering the surfaces above.
- [x] Run the governance test in isolation.
