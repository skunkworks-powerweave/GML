# Quickstart 136 — Mobile-aware login layout

Manual smoke (4 minutes):

1. Boot the stack: `pnpm dev` (web) + the docker-compose db /
   redis / minio bring-up.
2. Open `http://localhost:3000/login` in a desktop browser at
   1280×800. The layout is unchanged from spec 034 — left brand
   panel with the 600×600 mountain SVG and the prayer-flag accent,
   right form pane with email + password + the "Or sign in with"
   mode toggle, language picker absolute-positioned in the top
   right. Tab through the form to confirm focus order. Sign in
   with the seeded admin credentials (spec 086 seed) and confirm
   the `/dashboard` redirect lands.
3. Sign out. Now open Chrome DevTools, toggle the device toolbar
   (Cmd-Shift-M / Ctrl-Shift-M), pick a Pixel 7 (412×915) or any
   sub-768px viewport, and reload `/login`. The mobile shell
   takes over:
   - Full-bleed mountain hero at the top with the saffron→indigo
     gradient and the silhouette + sun disc.
   - GML wordmark and "Welcome back" headline inside the hero.
   - Mode toggle (Password / Magic link) below the hero.
   - Email + password inputs at 44px tall with 16px font size.
   - Big "Sign in" primary button below the password field.
   - Footer disclosure ("Goldenmile programme · audited" + build
     version).
   - Language pill row at the bottom — three 44×44 buttons:
     EN / हिं / བོད་.
4. Tap the Password / Magic link toggle. The form swaps to
   `EmailLinkForm`. Switch back. Both flows are gated by the same
   server action contracts the desktop shell uses, so a successful
   sign-in lands at `/dashboard` either way.
5. Tap हिं in the bottom pill row. The page refreshes; the hero
   headline and form labels render in Devanagari (the spec 125
   bundle). Tap བོད་ — Bhoti / Ladakhi, in Tibetan script. Tap EN to return.
6. On a real iPhone, open Safari, navigate to the LAN dev URL
   (e.g. `http://192.168.1.10:3000/login` after running the dev
   server with `--host 0.0.0.0`). Verify:
   - The hero clears the dynamic island / notch area.
   - The language pill row sits above the home indicator (does
     not overlap or get covered).
   - The keyboard appearing on email-field focus does not zoom
     the page (16px font size prevents iOS auto-zoom).

Resize the browser across the 768px breakpoint with the DevTools
toolbar off: the cookie set by `useDeviceType` on whichever shell
loaded first persists, so the next page load reflects that
choice. Refresh after each resize to see the server-side branch
swap to the other shell.

## Verification commands

```
pnpm test -- --grep "spec 136"
```

Should print 12 passing assertions.

```
pnpm build
```

Should complete cleanly. The login page is now a server
component; the previous `"use client"` warnings about server-side
hooks on the login route are gone.
