# Research 016

## D-001: `learning_outcomes` as jsonb string array

Frontend renders learning outcomes as a bulleted list. jsonb of string[] keeps it flexible (admin can edit via JSON-schema editor in spec 073). If structured outcomes (Bloom level, assessment type) become needed, the jsonb shape evolves without a migration.

## D-002: `status` as varchar, not enum

Three values today (planned | in_progress | complete) but a future "archived" or "review" might appear. Varchar + Zod-layer validation is the right level of strictness.

## D-003: UNIQUE `(subject_id, grade, term)`

A single subject in a single grade in a single term has one canonical outline. Multiple outlines for the same triple is a data-entry mistake.
