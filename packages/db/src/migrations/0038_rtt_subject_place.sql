-- Where an RTT subject is taught: the whole programme, one district, or one
-- zone.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
--
-- RTT is organised district > zone > term > subject, but rtt_subjects carried
-- only term_id and nothing above it had any geography. /rtt listed every
-- subject of every phase to every user, under a hard-coded "across Leh +
-- Kargil", so a programme running different subjects or schedules in Leh and
-- Kargil, or in one zone, could not say so, and a teacher saw the whole
-- programme instead of her own track (F42).
--
-- ── THE COLUMNS ──────────────────────────────────────────────────────────────
--
-- district_id and zone_id, both NULLABLE, AT MOST ONE set
-- (rtt_subjects_one_place):
--   neither   the whole programme -- every existing row, so nothing changes
--             for a deployment until an administrator scopes a subject
--   district  every zone of that district
--   zone      that zone only; its district is the zone's, so it is not stored
--             twice and cannot disagree with it
-- A teacher's own district and zone come from the existing chain teachers ->
-- schools -> zones -> districts; nothing about teachers changes.
--
-- RESTRICT, like the other geography keys since 0031: a district or zone
-- that subjects are still scoped to cannot be deleted out from under them.

ALTER TABLE "rtt_subjects" ADD COLUMN IF NOT EXISTS "district_id" uuid;--> statement-breakpoint
ALTER TABLE "rtt_subjects" ADD COLUMN IF NOT EXISTS "zone_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "rtt_subjects"
    ADD CONSTRAINT "rtt_subjects_district_id_districts_id_fk"
    FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "rtt_subjects"
    ADD CONSTRAINT "rtt_subjects_zone_id_zones_id_fk"
    FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "rtt_subjects"
    ADD CONSTRAINT "rtt_subjects_one_place" CHECK ("district_id" IS NULL OR "zone_id" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rtt_subjects_district_idx" ON "rtt_subjects" USING btree ("district_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rtt_subjects_zone_idx" ON "rtt_subjects" USING btree ("zone_id");
