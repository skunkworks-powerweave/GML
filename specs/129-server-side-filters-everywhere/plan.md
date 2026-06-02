# Plan 129

CREATED: `specs/129-server-side-filters-everywhere/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_129_server_side_filters_everywhere.test.mjs`
EDITED: `apps/web/src/app/(authenticated)/observation/page.tsx`, `apps/web/src/app/(authenticated)/repo/schools/page.tsx`, `apps/web/src/app/(authenticated)/repo/subjects/page.tsx`, `apps/web/src/app/(authenticated)/repo/outlines/page.tsx`, `apps/web/src/app/(authenticated)/repo/sessions/page.tsx`, `apps/web/src/app/(authenticated)/repo/teachers/page.tsx`, `apps/web/src/app/(authenticated)/videos/page.tsx`, `apps/web/src/app/(authenticated)/mentorship/page.tsx`
MIGRATED: none — every filter narrows on a column that already exists (observation_cycles.status / .kind, schools→zones→districts.code, subjects.grades_min/max, course_outlines.grade/.term/.status, sessions.status/.subject_id/.scheduled_date, teachers.school_id/.current_phase_id, video_submissions.status/.source, mentor_pairings.status)
