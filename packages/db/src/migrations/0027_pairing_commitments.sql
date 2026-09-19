-- Give the commitments register somewhere to live.
--
-- ── WHAT WAS THERE ───────────────────────────────────────────────────────────
--
-- A HARDCODED ARRAY OF FOUR STRINGS, rendered on every pairing page as if it
-- were that pairing's data:
--
--     "Use 4-minute cool-down in every lesson"      mentee   Wk 8
--     "Share sound-box video with cohort"           mentor   Wk 7
--     "Co-teach with mentee at school visit"        mentor   Wk 6
--     "Track exit-ticket completion daily"          mentee   Wk 7
--
-- Every mentor saw the same four, for every teacher they mentor. The toggle
-- wrote an audit row and persisted nothing, so a mentor could tick an item, see
-- nothing change, reload, and find it untouched.
--
-- This is the one place in the application that rendered invented content as
-- real programme data. A prior audit concluded "no page renders mock or
-- placeholder data"; this page did, and the sample text is plausible enough
-- that a mentor could reasonably have believed these were commitments someone
-- had agreed with their mentee.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────
--
-- jsonb on the pairing rather than a table: a commitments list is small,
-- always read with its pairing, never queried across pairings, and has no
-- foreign keys of its own. A table would be four joins and a migration for no
-- gain. If commitments ever need cross-pairing reporting, that is the moment to
-- promote them.
--
-- Each entry carries a uuid. The toggle used to address items BY INDEX, which
-- is unstable the moment anything is inserted or removed — two mentors editing
-- concurrently would toggle each other's items.
--
--   [{ "id": uuid, "text": string, "who": "mentor"|"mentee",
--      "due": string|null, "done": bool, "doneAt": iso|null, "doneBy": uuid|null }]

ALTER TABLE "mentor_pairings"
  ADD COLUMN IF NOT EXISTS "commitments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- Must be an ARRAY. Without this a malformed write could store an object or a
-- scalar, and every reader that iterates it would throw on a page mentors open
-- daily.
DO $$ BEGIN
  ALTER TABLE "mentor_pairings"
    ADD CONSTRAINT "mentor_pairings_commitments_is_array"
    CHECK (jsonb_typeof("commitments") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
