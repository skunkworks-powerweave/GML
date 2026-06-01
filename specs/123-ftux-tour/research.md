# Research 123

Three decisions worth recording.

(1) Storage: the prototype keys completion in `localStorage` with a
`gml.ftux.done.<role>.<username>` key. The live build uses
`user_prefs.ftux_seen_at` (already on the schema, nullable timestamp).
The server-side store wins for three reasons: it survives across
devices (a Ladakhi teacher may finish onboarding on a school laptop
and re-sign-in on a borrowed phone), it survives across reinstalls,
and it keeps the audit trail consistent — every change to
`user_prefs` already records an `user_prefs.update` audit row via the
existing API route, so we get a "first sign-on completed FTUX" line
without writing new code. localStorage would have skipped audit
entirely.

(2) Re-arming: clicking "Replay tour →" from `/settings` PUTs
`{ftuxSeenAt: null}` and full-reloads. A purer client-state lift
(set state high up in the tree, mutate it on click) was considered
but rejected — the FTUX overlay mounts in `(authenticated)/layout.tsx`
which is a server component, so re-arming requires either a route
refresh or migrating the layout to a client boundary. A page reload
is the cheaper of the two and the FTUX is a once-a-quarter event.

(3) Mobile: the prototype's FTUX_TOURS map targets selectors that
exist only on the desktop sidebar + topbar. On the mobile shell the
bottom tabs render with different markup; `querySelector` will miss
and the ring will not paint. The caption still mounts at the
prototype's fallback position (top:100, left:100) — we accept that
the FTUX is a desktop-first pedagogical layer for now. A mobile
overlay would need its own step list (the tab labels are different)
and is a larger design exercise; deferring to a future spec.

The `data-help-anchor` rename on Sidebar.tsx (id → `nav-${id}`) and
the new anchor on Topbar.tsx are deliberate: they make the
prototype's selector contract (`[data-help-anchor='nav-mentorship']`,
`[data-help-anchor='topbar-help']`) match the live DOM verbatim, so a
future spec that reuses the same anchor namespace (e.g. an in-app
hint banner) doesn't need to relearn the convention.
