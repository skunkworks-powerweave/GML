-- 011 — put `pairing.final_submitted` into notifications_enabled.
--
-- WHY
--
-- A pairing's final (Q4) form is what makes it ready for an administrator to
-- close, and nothing said it had happened. submitFormAction now writes a
-- `pairing.final_submitted` notice to the programme admins and the other party
-- on the pairing. /inbox and the bell show only the kinds in
-- `system_settings.notifications_enabled`, so a new kind that is not in the
-- array is written and hidden -- the defect _post/006 and _post/010 fixed for
-- earlier kinds.
--
-- The column default is corrected in the Drizzle schema. This file handles the
-- row that is already there. As in 006, we APPEND rather than reset: the kind
-- is new, so its absence is not an administrator's choice. An administrator
-- who switched EVERY kind off meant it, and an empty array stays empty.
--
-- Idempotent: the `NOT ... ?` guard makes a second run a no-op, which matters
-- because the _post lane replays on every deploy.

ALTER TABLE public.system_settings
  ALTER COLUMN notifications_enabled
  SET DEFAULT '["helpdesk.ticket","cycle.assigned","cycle.complete","video.transcoded","meeting.scheduled","meeting.cancelled","pairing.final_submitted"]'::jsonb;

UPDATE public.system_settings
   SET notifications_enabled = notifications_enabled || '["pairing.final_submitted"]'::jsonb
 WHERE jsonb_typeof(notifications_enabled) = 'array'
   AND NOT (notifications_enabled ? 'pairing.final_submitted')
   AND jsonb_array_length(notifications_enabled) > 0;
