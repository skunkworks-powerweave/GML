# Research 122

Four design choices that diverge from a one-shot port:

1. **Custom DOM event over context.** The prototype uses an
   in-component `useHelp()` hook to hand `openWith(k)` down through
   props. A React Context would work here but requires the
   provider tree to wrap every authenticated route — that means
   any page that wants to drop in a `<HelpTip>` would force the
   layout to become a client boundary. We instead dispatch a
   `gml:open-help` `CustomEvent` on the `window`. HelpPanel
   listens at the window level; HelpTip / HelpDot / HelpHeadbtn
   call `openHelp(slug)` which dispatches the event. The whole
   layout file stays a server component, the dictionary stays
   importable from anywhere, and the panel keeps its own state.

2. **No new env vars required.** The "Talk to a person" card
   reads `GML_HELPDESK_PHONE` and `GML_HELPDESK_EMAIL` from
   `process.env` at SSR time. If unset, we fall back to existing
   env contracts (`WHATSAPP_PHONE_NUMBER_ID` and `SMTP_FROM`) so
   no deployment-doc update is needed to ship the spec. If even
   the fallbacks are unset, the corresponding buttons render in a
   disabled state with an explanatory label rather than as
   silently broken affordances.

3. **Notifications, not a helpdesk_tickets table.** The brief
   permits either route ("pick the lighter path — notification is
   simpler"). We pick the lighter path: the existing inbox/
   notifications stack already renders user-facing operational
   events, has its SM-8 retention sweep (spec 107), and is read
   by the admin role today (`/inbox`). A helpdesk_tickets table
   would need its own migration, an admin list view, and a status
   pipeline (open/in-progress/closed/etc.) that does not exist
   yet. Reusing notifications gets us to a working flow today
   without committing to a status model we will likely re-shape
   when the dedicated helpdesk view ships.

4. **Mobile = full-screen drawer via CSS only.** The spec asks
   for a 380px-wide desktop panel and a full-screen mobile
   drawer. We pick `width: min(380px, 100vw)` which gives both
   without a media query, no useDevice hook, no extra render
   pass. The same instance covers both shells.
