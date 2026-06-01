# Spec 122 — Help panel + dictionary (frontend-parity Run 10)

## Why

The JSX prototype (LMS GML Frontend/help.jsx, ~700 LOC) ships an
end-to-end help system: a 50-entry dictionary, hover/tap tooltips,
a side panel, page-header ⓘ buttons, a `?` keyboard shortcut and
a "Talk to a person" card. Workflow Run 9 explicitly cut the side
panel and tour (see spec 029's annotation in `Topbar.tsx`); the
audit at the close of Run 9 surfaced this as one of six dropped
features that the prototype actually expects every page to lean on.
The user has now requested full prototype parity — including the
help system — and this spec revives it.

The dropped MobileHelpFAB (spec 032) remains in place for mobile
quick-orientation bullets; this spec adds the dictionary-driven,
keyboard-navigable side panel that lives one altitude above it.

## What ships

A complete, prototype-faithful help system with five pieces:

1. **HELP dictionary** (`apps/web/src/lib/help.ts`). All ~50
   entries from `help.jsx` ported verbatim: top-level objects
   (school, class, subject, outline, session, teacher, mentor,
   mentee, pairing, student, resource), observation internals
   (observation, cycle, pre_form, post_form, sign_off, baseline,
   developmental, evaluative, rubric), RTT structure (rtt, phase,
   phase_1/2/3, district, zone, term, quarter), mentorship
   internals (feedback_form, commitment, growth_move, strength),
   7 status pills (status_nominated → status_in_progress), video
   pipeline (watermark, hls, transcoding, whatsapp_ingest), auth
   /security (section_gate, audit, confidentiality), 5 roles
   (role_super_admin → role_teacher), and common fields (attendance,
   cohort). Each entry carries `title`, `short` (≤25 words),
   optional `long` (2–3 paragraph), optional `related` slug array
   and an opt-in `seeAlso` route hint for deep-link affordances.
   The dictionary is exported as a frozen object so no caller can
   mutate it at runtime.

2. **HelpTip** (`apps/web/src/components/help/HelpTip.tsx`). The
   prototype's dotted-underline word wrapper. Hover (desktop) and
   tap (mobile) show a 220–320px tooltip with title + short. A
   "Tell me more →" button inside the tooltip fires the global
   `gml:open-help` event so HelpPanel anchors on the same topic.
   Outside-click closes for tap-to-open users.

3. **HelpDot** (`apps/web/src/components/help/HelpDot.tsx`). A bare
   ⓘ circle that pops the same tooltip. Used inside Stat labels,
   table column headers and anywhere a phrase can't carry its
   own underline.

4. **HelpHeadbtn** (`apps/web/src/components/help/HelpHeadbtn.tsx`).
   The page-header ⓘ button. One click opens HelpPanel anchored on
   the current page's primary topic. Carries
   `data-help-anchor="topbar-help"` so the FTUX tour from spec
   123 can highlight it.

5. **HelpPanel** (`apps/web/src/components/help/HelpPanel.tsx`).
   A 380px-wide slide-out aside on desktop (`min(380px, 100vw)`
   = full-screen drawer on mobile). Carries a search input
   (live-filters the dictionary), the current topic's title +
   short + long + related-topics chips, a "Browse all" grouped
   list keyed by HELP_GROUPS, a "Talk to a person" card with
   three real wired buttons, and a footer crediting the `?`
   shortcut. Mounted globally via `(authenticated)/layout.tsx`.

6. **`?` keyboard shortcut**. Listens at the window level,
   respects INPUT/TEXTAREA/contenteditable focus, and toggles the
   panel. Also accepts `Shift+/` and `⌘?`. A standalone
   `useHelpShortcut` hook is exported for any page that wants to
   listen for the shortcut without rendering the panel.

7. **`/api/helpdesk/tickets`** (POST). The "Talk to a person"
   card's third button posts here. We pick the lighter path: no
   new table. The endpoint inserts a `notifications` row for every
   active programme_admin + super_admin user with
   `kind="helpdesk.ticket"`. The inbox (spec 070) already renders
   notifications, so admins see the ticket alongside other
   operational events. SM-8 retention (spec 107) sweeps these
   rows after 90 days.

## "Talk to a person" wiring

The prototype's three inert buttons (help.jsx lines 641-655) ship
as three real affordances:

- **WhatsApp programme team** → `https://wa.me/<phone>?text=<pre-filled context message>`.
  The phone is read from `process.env.GML_HELPDESK_PHONE` with a
  fallback to `WHATSAPP_PHONE_NUMBER_ID`. If neither is set, the
  button renders disabled with an explanatory label so the
  affordance is never silently broken.
- **Email admin** → `mailto:<email>?subject=Help: <page-slug>&body=<context>`.
  The address is read from `GML_HELPDESK_EMAIL` with a fallback
  to `SMTP_FROM`.
- **Open helpdesk ticket** → POST to `/api/helpdesk/tickets`.
  The endpoint validates with Zod, fans out a notification to
  every active admin user (excluding the opener), writes an
  audit row `helpdesk.ticket_opened`, and returns
  `{ ok: true, delivered: <count> }`. The button transitions
  through `idle → sending → sent ✓` and recovers to a "Retry"
  label on failure.

## Integration

`(authenticated)/layout.tsx` mounts `<HelpPanel contact={…} />`
once, alongside the existing FTUXTour and AntiDownloadGuard. The
panel is invisible until opened. HelpTip / HelpDot / HelpHeadbtn
are imported inline by any page that wants to wrap a term, label
or page-title.

## Acceptance criteria

- `apps/web/src/lib/help.ts` exports `HELP`, `HELP_GROUPS`,
  `HELP_KEYS`, `helpFor()` and `searchHelp()`; `HELP` includes the
  full set of prototype slugs (≥ 50 entries) including the seven
  status_* pills, five role_* pills and the four video-pipeline
  topics.
- All four React components compile as `'use client'` islands.
- `HelpPanel` dispatches/listens for the `gml:open-help` custom
  event, owns the `?` shortcut, renders the search box, the
  related-topic chips, the Browse-all grouped list and the
  "Talk to a person" card.
- The "Talk to a person" card's three buttons are wired to:
  `wa.me/<phone>`, `mailto:<email>`, and `POST /api/helpdesk/tickets`.
- `/api/helpdesk/tickets` is a Zod-validated POST that inserts a
  notification per active admin and audits
  `helpdesk.ticket_opened`. Other methods return 405; no session
  returns 401.
- `(authenticated)/layout.tsx` mounts `<HelpPanel>` alongside
  FTUXTour and AntiDownloadGuard.
- All five spec-kit files exist under
  `specs/122-help-panel-and-dictionary/`.
- `tests/governance/test_122_help_panel_and_dictionary.test.mjs`
  has 8+ assertions and passes.

## Non-goals

- **No new env vars are required.** `GML_HELPDESK_PHONE` and
  `GML_HELPDESK_EMAIL` are optional overrides; the layout falls
  back to existing env contracts.
- **No new table.** Tickets piggy-back on the notifications inbox.
- **No FTUX coach-marks here.** Spec 123 owns the
  role-specific tour overlay; this spec only ships the
  `data-help-anchor` hook the tour reads off the HelpHeadbtn.
- **No CSS module.** Components carry inline styles using the
  existing token names (`--ink`, `--ink-2`, `--ink-3`, `--paper`,
  `--card-hi`, `--line`, `--r-2`, `--r-3`, `--shadow-2`, etc.).
  Matches the rest of the codebase's styling approach.
