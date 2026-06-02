# Plan 127

CREATED: `specs/127-dashboard-stats-real-counts/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_127_dashboard_stats_real_counts.test.mjs`
EDITED: `apps/web/src/app/(authenticated)/dashboard/page.tsx` (rewrite getCounts into five React.cache-wrapped chrome helpers — getProgrammeChrome / getTeacherChrome / getObserverChrome / getMentorChrome / getFieldMapSchools — each fired as a Promise.all of count() queries scoped to session.user.id; replace hardcoded TodayChecklist rows with derived todo lists per role; render a real-data FieldMap for super_admin + programme_admin only; add dashboard.viewed audit)
MIGRATED: none — every count derives from existing columns on `video_submissions`, `observation_cycles`, `observation_forms`, `mentor_pairings`, `mentor_meetings`, `mentors`, `teachers`, `schools`, `users`, `quizzes`, `quiz_submissions`, `files`, `audit_log`; no new schema columns or tables required per the run's data-wiring-only rule
