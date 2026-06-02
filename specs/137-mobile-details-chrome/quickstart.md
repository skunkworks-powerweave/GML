# Quickstart 137 — Mobile detail-page chrome

Manual smoke (5 minutes, mobile emulation):

1. Boot the stack: `pnpm dev` (web) + docker-compose db / redis / minio.
2. Open Chrome DevTools, switch to mobile emulation (iPhone 14 or
   Pixel 7), reload `/`. Sign in as a `mentor`.
3. Navigate to `/observation` and tap any cycle row. The detail page
   renders inside the new MobileDetailFrame chrome:
   - 44px thin header at top, var(--paper-2) bg, separator line below.
   - Back arrow (`←`) on the left, 44x44 tap target. Tap it — you land
     back at `/observation`.
   - Title centered (teacher's full name), ellipsis-truncates if the
     name is long.
   - On iPhone with a notch (use the DevTools notch toggle), the header
     pads down to clear the camera cutout.
4. From `/observation`, open a cycle that is in `post_submitted`
   status. The "Sign off cycle" button is now at the bottom of the
   screen in a sticky bar — scroll the page; the bar stays put. Tap
   it; the cycle transitions to `complete` and the bar disappears (it
   was conditional on `canSignOff`).
5. From `/mentorship`, tap a pairing row. The mobile chrome shows
   "Mentor ↔ Mentee" as the title (truncated with ellipsis on a 360px
   viewport). Tap the back arrow — `/mentorship`.
6. From `/repo`, tap "Schools" → tap a school row. Mobile chrome shows
   the school name as title, `/repo/schools` as the back target. From
   inside the school, tap a class — the chrome's back arrow now points
   back to the school (`/repo/school/<id>`), not the root /repo. This
   matches the inline ← link that desktop renders.
7. Inside a school, tap a teacher → mobile chrome shows teacher name as
   title, `/repo/teachers` as the back href.
8. Switch back to desktop viewport (1280x800). Reload any of the five
   pages — the two-column desktop layout renders unchanged. No
   MobileDetailFrame chrome appears.

Verify the safe-area inset behaviour:

- On the iPhone 14 emulator (or any device with a notch), the header's
  `paddingTop: env(safe-area-inset-top, 0)` adds ~47px of clear space
  above the chrome on landscape orientation. Toggle DevTools' device
  rotation to confirm.
- On the iPhone 14 emulator, the sticky bar's
  `paddingBottom: calc(10px + env(safe-area-inset-bottom, 0))` keeps
  the Sign-off button clear of the home indicator (~34px clearance).

Accessibility smoke:

- VoiceOver / TalkBack: the back arrow announces as "Back, button".
  The title announces as a level-1 heading.
- Keyboard nav: Tab focuses the back arrow first, then traverses into
  the body. Enter on the focused back arrow navigates to backHref.
- Color contrast: the title text (var(--ink) on var(--paper-2))
  exceeds WCAG AA at 4.5:1.
