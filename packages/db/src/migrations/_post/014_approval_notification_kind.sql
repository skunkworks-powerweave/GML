-- 014 — put `approval` into notifications_enabled.
--
-- WHY
--
-- lib/approvals writes an `approval` notice to the approvers when a lesson
-- plan, session, marks, teach-back, sign-off or account request is waiting, and
-- to the sender when it is decided. /inbox and the bell show only the kinds in
-- `system_settings.notifications_enabled`, so a kind missing from the array is
-- written and hidden -- the defect _post/006, 011 and 012 fixed for earlier
-- kinds.
--
-- Migration 0043 sets the column default, but on a fresh database the
-- numbered migrations run BEFORE this lane, and _post/012 then set the default
-- back to its own list without `approval`. This file runs after 012, so the
-- default ends up the same on a fresh database as on an existing one (where
-- 012 was already in the ledger and never ran again).
--
-- As in 012, we APPEND rather than reset: the kind is new, so its absence is
-- not an administrator's choice. An administrator who switched EVERY kind off
-- meant it, and an empty array stays empty.
--
-- Idempotent: the `NOT ... ?` guard makes a second run a no-op, which matters
-- because the _post lane replays on every deploy.

ALTER TABLE public.system_settings
  ALTER COLUMN notifications_enabled
  SET DEFAULT '["helpdesk.ticket","cycle.assigned","cycle.complete","video.transcoded","meeting.scheduled","meeting.cancelled","pairing.final_submitted","approval"]'::jsonb;

UPDATE public.system_settings
   SET notifications_enabled = notifications_enabled || '["approval"]'::jsonb
 WHERE jsonb_typeof(notifications_enabled) = 'array'
   AND NOT (notifications_enabled ? 'approval')
   AND jsonb_array_length(notifications_enabled) > 0;
