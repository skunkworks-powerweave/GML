# Tasks 121

- [x] T1 → write governance test asserting the API route + client component contract → red
- [x] T2 → implement `GET /api/quickfind` with the 8-entity ILIKE fan-out, MIN_QUERY/MAX_PER_KIND/HARD_CAP, and the `quickfind.query` audit row → green for the route assertions
- [x] T3 → implement `<QuickFind userId>` client component: Cmd/Ctrl+K toggle, Esc/background/select close, debounced fetch, keyboard nav, localStorage recents → green for the component assertions
- [x] T4 → wire `<QuickFind userId={user.id} />` into `(authenticated)/layout.tsx` in both desktop and mobile branches → green for the layout assertions
- [x] T5 → author spec.md, plan.md, research.md, quickstart.md, tasks.md under specs/121-quick-find-cmdk/
- [ ] T6 (future spec) → if quickfind audit volume becomes a retention concern, add a per-action TTL override on audit_log or batch the debounced fetches into a single audit-on-close row
- [ ] T7 (future spec) → if cross-device recents matter, persist them server-side and fall back to localStorage; the QuickFind component's public API does not need to change
