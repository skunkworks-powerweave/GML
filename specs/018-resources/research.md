# Research 018

- `kind` as varchar+CHECK to keep flexible for partner orgs adding "Rubric" or "Calendar template".
- `file_key` and `external_url` mutually-optional but at least one required (a resource with neither has no actual content).
- `tags jsonb` for free-form categorization (e.g. ["NEP 2020", "Grade 5", "Reading"]) without a separate tags table — adequate at this scale.
- Many-to-many via `resource_subjects` rather than `resources.subject_id` because real resources span subjects (e.g. "Phonics handbook" applies to English + Hindi + Urdu).
