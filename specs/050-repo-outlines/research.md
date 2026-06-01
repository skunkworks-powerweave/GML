# Research 050

## D-001 — Reading material filter is subject-tagged via `resource_subjects` join, not `tags` jsonb

The JSX uses `r.subjects.includes(outline.subject)` against mock data. The production schema uses the many-to-many `resource_subjects` table (spec 018) which is the correct relational source of truth — `resources.tags` is for free-form labels, not curriculum subjects. The detail page joins `resource_subjects` on `resourceId` and filters by `subject_id = outline.subject_id`.
