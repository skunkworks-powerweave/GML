# Quickstart 122 — Help panel + dictionary

Manual smoke (2 minutes): boot the app, sign in.

1. Press `?` anywhere — the side panel slides in from the right
   (or fills the screen on mobile). It opens on the Browse-all
   view: seven topic groups (Core ideas, People, Where, …),
   each carrying a list of ~5–10 topics. The search box at the
   top is auto-focused.
2. Type a query (e.g. "mentor"). The panel switches to a
   results view showing every dictionary entry whose key,
   title, short or long contains the substring. Click any row
   — the panel jumps to the topic's full detail view.
3. The detail view shows the topic's title (serif, 20px), its
   `short` line, then its `long` paragraph, then related-topic
   chips (clicking a chip navigates to that topic). Below the
   chips is the "← Back to all topics" button.
4. Under that sits the "Talk to a person" card with three real
   buttons. WhatsApp opens `wa.me/<phone>` in a new tab with a
   pre-filled message ("Hi! I have a question about <topic>
   (page <slug>)."). Email opens `mailto:<email>` with the
   page slug in the subject. Open helpdesk ticket POSTs to
   `/api/helpdesk/tickets` and transitions through
   "Sending… → Helpdesk ticket sent ✓". An admin's `/inbox`
   page (spec 070) gets a new notification immediately.
5. Wrap any term in a page using `<HelpTip k="cycle">cycle</HelpTip>`
   — the word gets a dotted underline on hover, the tooltip
   shows the title + short, and "Tell me more →" inside the
   tooltip opens the panel anchored on that slug.
6. Drop `<HelpDot k="attendance" />` next to a column header —
   a small ⓘ circle appears; same tooltip behaviour, no underline
   on the surrounding text.
7. Add `<HelpHeadbtn k="rtt" />` next to a page title — a
   round ⓘ button anchored to the topbar-help discoverability
   spot. One click opens the panel anchored on the page's slug.

Headless smoke: `node --test tests/governance/test_122_help_panel_and_dictionary.test.mjs`.
The test verifies that the dictionary carries every prototype
slug, that all four components and the hook compile as
`'use client'` islands, that the layout mounts `<HelpPanel>`,
that `/api/helpdesk/tickets` validates with Zod + audits
`helpdesk.ticket_opened`, and that the spec-kit files are all
present.
