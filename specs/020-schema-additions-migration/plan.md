# Plan 020

EDITED:
- packages/db/src/schema/geography.ts — schools.code + teachers.{hindi_name, current_phase_id}
- packages/db/src/schema/mentorship.ts — mentors.{hindi_name, base_location} + mentor_pairings.{current_quarter, meetings_count, last_meeting_at}
- packages/db/src/schema/observation.ts — observation_cycles.{subject_id, topic, video_min}
- packages/db/src/schema/identity.ts — users.hindi_name
- apps/web/src/admin/entities/{schools,teachers,mentors,mentor-pairings}.ts — new columns in displayColumns + formSchema
- packages/db/src/migrations/0009_schema_additions.sql — drizzle-kit auto + descriptive rename

CREATED:
- tests/governance/test_020_schema_additions.test.mjs
- spec-kit files
