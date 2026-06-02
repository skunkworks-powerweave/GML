# Quickstart 128 — Chrome dynamic counts and bell

## How to verify locally

1. Log in as a mentor (any mentor seeded into the dev DB). The
   sidebar should show "My mentees" with a count chip equal to
   `SELECT count(*) FROM mentor_pairings WHERE mentor_id = (your
   mentor row).id AND status = 'active'`. Open psql, run that
   query, confirm the chip matches.
2. The "Observation cycles" row should show the count of cycles
   in `('pre_submitted', 'observed', 'post_submitted')`. Verify
   with `SELECT count(*) FROM observation_cycles WHERE status IN
   ('pre_submitted','observed','post_submitted');`.
3. Log in as a teacher. The "My uploads" row should reflect the
   number of video_submissions submitted by this user in the last
   30 days. Submit a new video; refresh — the count goes up.
4. The bell in the topbar is now a Link to /inbox. Hover it; the
   browser's status bar reads `/inbox`. Click; you land on the
   inbox.
5. Generate a notification for the logged-in user (insert via
   psql) and refresh. The bell chip shows the unread count.
   Visit /inbox and click "Mark all read" — the chip disappears
   on the next render.
6. With the dev worker stopped (or Redis down), the queue
   indicator should be absent (loader fails closed). Restart the
   worker, enqueue a job (drop a WhatsApp video into the seeded
   webhook), and the chip appears: e.g. `1 waiting`.
7. `curl -s http://localhost:3000/api/notifications/unread-count
   --cookie 'next-auth.session-token=…'` returns
   `{"count": N}` matching the badge.

## How to run the governance test

From the repo root:

```
pnpm test --filter @gml/web tests/governance/test_128_chrome_dynamic_counts_and_bell.test.mjs
```

The suite asserts:
- All five spec-kit files exist and the plan declares CREATED /
  EDITED / MIGRATED lines.
- `chrome-counts.ts` exports the four loader functions, wraps them
  in `React.cache`, and exports the `NavCounts` and `QueueDepth`
  types.
- `layout.tsx` imports the three loaders and calls them in a
  `Promise.all`.
- `Sidebar.tsx` accepts a `counts` prop and runs it through
  `applyNavCounts`.
- `BottomTabs.tsx` accepts `counts` + `unreadCount`.
- `Topbar.tsx` no longer renders the bell as a `<button>`; it's
  a `<Link href="/inbox">` with a `data-testid="topbar-bell"`
  attribute. The queue indicator has a stable
  `data-testid="topbar-queue-indicator"`.
- The `/api/notifications/unread-count/route.ts` GET handler exists
  and returns 401 on unauth.
- No TODO / FIXME markers leaked into shipped source.

## Rollback

`git revert` of the spec 128 commit removes the three new loaders
and the wiring. The hardcoded `count: 5` etc. on NAV_BY_ROLE come
back unchanged; chrome falls back to prototype numbers immediately.
No schema changes to undo.
