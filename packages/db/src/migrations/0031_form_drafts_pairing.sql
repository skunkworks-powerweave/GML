-- Scope a feedback-form draft to the PAIRING it is about.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
--
-- A mentor answers each quarterly form once per mentee, but a draft was unique
-- on (user_id, template_id) alone -- form_drafts_user_template_uq. One mentor,
-- one progress_1 form, one draft, shared by all five mentees:
--   - half-written answers about mentee A loaded into mentee B's form under a
--     "Draft loaded" chip, and submitting there filed them against B;
--   - the shared draft outranked B's own submitted answers on "View responses";
--   - submitting any mentee's form deleted the one draft, discarding the
--     unfinished form about every other mentee.
--
-- ── THE KEY NOW ──────────────────────────────────────────────────────────────
--
-- (user_id, template_id, pairing_id), NULLS NOT DISTINCT, so the one draft a
-- user keeps for a form opened WITHOUT a pairing (an administrator's preview)
-- is still a single row that the autosave upsert can find: with the default
-- NULLS DISTINCT every save would insert another. Drizzle 0.39's index builder
-- cannot express NULLS NOT DISTINCT, which is why schema/formDrafts.ts declares
-- the index without it and this file is the authority.
--
-- Existing drafts keep pairing_id NULL. Which mentee a shared draft was about
-- cannot be recovered from the row, and guessing would re-create the defect.
-- The pairing-bound runner reads only its own pairing's draft, so such a row
-- is offered only on the bare form URL (/forms/<slug>, no pairing), to the
-- user who wrote it -- and, like every form draft, only once the mentorship
-- section is unlocked (the runner and /api/form-drafts both ask).
--
-- Observation-cycle drafts (observation_cycle_id) are untouched: a cycle is
-- already one teacher.

ALTER TABLE "form_drafts" ADD COLUMN IF NOT EXISTS "pairing_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "form_drafts"
    ADD CONSTRAINT "form_drafts_pairing_id_mentor_pairings_id_fk"
    FOREIGN KEY ("pairing_id") REFERENCES "public"."mentor_pairings"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- A pairing only qualifies a template draft; a cycle draft has no pairing.
DO $$ BEGIN
  ALTER TABLE "form_drafts"
    ADD CONSTRAINT "form_drafts_pairing_needs_template"
    CHECK ("pairing_id" IS NULL OR "template_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DROP INDEX IF EXISTS "form_drafts_user_template_uq";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "form_drafts_user_template_pairing_uq"
  ON "form_drafts" USING btree ("user_id", "template_id", "pairing_id") NULLS NOT DISTINCT
  WHERE "template_id" IS NOT NULL;
