# Quickstart 127 — Dashboard real counts

Manual smoke (5 minutes):

1. Boot the stack: `pnpm dev` (web) + docker-compose db/redis/minio.
2. Sign in as a `super_admin` (bootstrap user from spec 103). The
   dashboard now renders **seven** stat cards (active pairings,
   cycles in flight, recent uploads, pending observer forms,
   total users, audit events 24h, storage used MB). The "today"
   panel shows real pending-work items per the actual DB state.
3. Below the today/confidentiality row, the "Field operations"
   card renders one dot per active school. Hover a dot — the SVG
   `<title>` shows the school name + code. Click — you land on
   `/repo/school/<id>`.
4. Sign in as a `programme_admin` — same four base stats, no
   total-users / audit / storage cards. FieldMap still visible.
5. Sign in as a teacher seeded with a pairing + an active cycle in
   `nominated` status. The dashboard now shows "My uploads this
   week", "Cycles pending pre-form", "Cycles awaiting video",
   "Open quizzes". The "What's next" panel lists real todos linked
   to /observation, /uploads, /rtt.
6. Sign in as a mentor (`mentors.user_id` linked). Stat cards
   show "Active mentees", "Pending video reviews", "Scheduled
   meetings this week", "Q-progress forms due". The "Today" panel
   shows up to three real todo rows pulled from the corresponding
   pending cycles / videos / meetings.
7. Sign in as an observer assigned to a cycle in `pre_submitted`.
   Stat cards show "Cycles I am leading (active)", "Pending
   observer forms", "Cycles awaiting sign-off". Todos link to
   /observation.
8. Open `/admin/audit` and filter `action = dashboard.viewed`.
   Each render is recorded with `metadata.role` so ops can sanity-
   check dashboard usage.

## Confirming the queries are scoped

- Sign in as a teacher A with one cycle in `pre_submitted`. Note
  the "Cycles awaiting video" card reads 1.
- Without signing out, browse cycles for teacher B (an admin
  surface). Teacher A's card should still read 1 — the dashboard
  is user-scoped, not session-cookie-scoped.
- Sign out, sign back in as teacher B (who has zero cycles).
  Teacher B's card reads 0.

This is what `React.cache` gives us — per-render, per-user
materialisation.

## Confirming the FieldMap matches real schools

```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM schools WHERE active = true"
```

The number of dots on the FieldMap must match this count. Click
any dot — the URL bar shows `/repo/school/<uuid>`, and the page
loads the school's repo entry.
