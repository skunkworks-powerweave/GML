# Quickstart 123 — FTUX coach-marks

Manual smoke (2 minutes on the desktop shell):

1. Boot the app, sign in as any seeded user whose `user_prefs` row
   does not yet exist, or as a user whose `ftux_seen_at` is NULL.
   The role-specific tour overlay paints immediately on top of the
   dashboard.
2. The first step's spotlight ring pulses around the first nav row
   for the role (Mentor → "My mentees"; Teacher → "My phase";
   Programme admin → "Repository"). The dimmed backdrop has a clean
   cutout around the highlighted control.
3. Resize the window — the ring + caption reposition. Scroll the
   page (or the sidebar) — same.
4. Click Next a few times. The dots row at the bottom of the caption
   advances; Back appears from step 2 onward. Each step's selector
   re-targets the spotlight.
5. On the last step click "Got it". The overlay disappears and a
   single PUT to `/api/user-prefs` fires with `{ftuxSeenAt: …ISO}`.
   Refresh — the overlay does not return.
6. Navigate to `/settings`. The Account section now shows a
   "Replay tour →" row. Click it. The form button flashes
   "Re-arming…" briefly, then the page full-reloads and the FTUX
   overlay paints again from step 1.
7. Click "Skip tour" from any step. Same PUT, same dismissal, same
   non-return on refresh.

Test smoke:
```
pnpm test -- tests/governance/test_123_ftux_tour.test.mjs
```
must pass green.
