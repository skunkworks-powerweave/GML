-- 010 — put `meeting.cancelled` and `cycle.complete` into notifications_enabled.
--
-- WHY
--
-- /inbox and the topbar bell show only the kinds in
-- `system_settings.notifications_enabled` (apps/web/src/lib/notification-kinds.ts).
-- The default was chosen when nothing wrote either of these kinds. Since then
-- cancelMeetingAction writes `meeting.cancelled` to the other people on the
-- pairing, and the observation sign-off writes `cycle.complete` -- and both
-- rows were written and then hidden. The mentee saw "a meeting was logged"
-- and never that it was called off, while the confirmation the mentor clicked
-- said she "will be told". So she could travel to a meeting that no longer
-- existed.
--
-- The column default is corrected in the Drizzle schema. This file handles the
-- row that is already there, which a default never touches -- as _post/006 did
-- for helpdesk.ticket.
--
-- We APPEND rather than reset, and only beside the kind's companion: a
-- deployment that still has `meeting.scheduled` on wants meeting notices, so
-- the cancellation joins it; one whose administrator switched
-- `meeting.scheduled` off has said it does not want them, and stays as it is.
-- The same for `cycle.complete` beside `cycle.assigned`. A companion present
-- also means the array is not empty, so an administrator who switched every
-- kind off stays off.
--
-- Idempotent: the `NOT ... ? kind` guards make a second run a no-op, which
-- matters because the _post lane replays on every deploy.

ALTER TABLE public.system_settings
  ALTER COLUMN notifications_enabled
  SET DEFAULT '["helpdesk.ticket","cycle.assigned","cycle.complete","video.transcoded","meeting.scheduled","meeting.cancelled"]'::jsonb;

UPDATE public.system_settings
   SET notifications_enabled = notifications_enabled || '["meeting.cancelled"]'::jsonb
 WHERE jsonb_typeof(notifications_enabled) = 'array'
   AND notifications_enabled ? 'meeting.scheduled'
   AND NOT (notifications_enabled ? 'meeting.cancelled');

UPDATE public.system_settings
   SET notifications_enabled = notifications_enabled || '["cycle.complete"]'::jsonb
 WHERE jsonb_typeof(notifications_enabled) = 'array'
   AND notifications_enabled ? 'cycle.assigned'
   AND NOT (notifications_enabled ? 'cycle.complete');
