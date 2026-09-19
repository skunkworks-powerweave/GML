-- 006 — put `helpdesk.ticket` into notifications_enabled.
--
-- WHY
--
-- The topbar bell counts unread notifications filtered by
-- `system_settings.notifications_enabled`. That array's default was
--   ["cycle.assigned","video.transcoded","meeting.scheduled"]
-- and `helpdesk.ticket` is the ONLY kind anything in the application writes.
-- So the filter could never match a real row: the bell read zero permanently
-- while help requests accumulated unread in /inbox. It was also not selectable
-- in the settings UI, so no administrator could have fixed it themselves.
--
-- The column default is corrected in the Drizzle schema. This file handles the
-- row that is already there, which a default never touches.
--
-- We APPEND rather than reset. Every other entry in that array is a real
-- administrator choice and must survive. `helpdesk.ticket`'s absence was not a
-- choice -- the checkbox did not exist -- so adding it back is restoring an
-- option, not overriding a decision.
--
-- Idempotent: the `NOT ... ? 'helpdesk.ticket'` guard makes a second run a
-- no-op, which matters because the _post lane replays on every deploy.

ALTER TABLE public.system_settings
  ALTER COLUMN notifications_enabled
  SET DEFAULT '["helpdesk.ticket","cycle.assigned","video.transcoded","meeting.scheduled"]'::jsonb;

UPDATE public.system_settings
   SET notifications_enabled = notifications_enabled || '["helpdesk.ticket"]'::jsonb
 WHERE jsonb_typeof(notifications_enabled) = 'array'
   AND NOT (notifications_enabled ? 'helpdesk.ticket')
   -- An administrator who has switched EVERY category off meant it. Adding a
   -- kind back to an empty array would silently re-enable notifications they
   -- deliberately turned off.
   AND jsonb_array_length(notifications_enabled) > 0;
