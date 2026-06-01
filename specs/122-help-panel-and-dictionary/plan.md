# Plan 122

CREATED: `specs/122-help-panel-and-dictionary/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_122_help_panel_and_dictionary.test.mjs`, `apps/web/src/lib/help.ts`, `apps/web/src/components/help/HelpPanel.tsx`, `apps/web/src/components/help/HelpTip.tsx`, `apps/web/src/components/help/HelpDot.tsx`, `apps/web/src/components/help/HelpHeadbtn.tsx`, `apps/web/src/components/help/useHelpShortcut.ts`, `apps/web/src/app/api/helpdesk/tickets/route.ts`
EDITED: `apps/web/src/app/(authenticated)/layout.tsx` (mount `<HelpPanel contact={…}>` globally alongside FTUXTour + AntiDownloadGuard; thread `GML_HELPDESK_PHONE` / `GML_HELPDESK_EMAIL` env reads with WhatsApp + SMTP fallbacks)
MIGRATED: none — spec 122 reuses the existing `notifications` table for helpdesk tickets and the existing `audit_log` for `helpdesk.ticket_opened` (audit_log.action is free-form varchar(64) per spec 021)
